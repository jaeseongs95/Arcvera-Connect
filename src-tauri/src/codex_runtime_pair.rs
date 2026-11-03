//! 읽기 전용 런타임 짝 검사. 버전 일치는 RPC 기능 지원을 보장하지 않는다.
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePairStatus {
    pub cli_version: String,
    pub selected_server_executable: String,
    pub selected_server_version: String,
    pub managed_cli_executable: Option<String>,
    pub managed_version: Option<String>,
    pub running_version: Option<String>,
    pub socket_path: Option<String>,
    pub state: String,
    pub message: Option<String>,
}

fn bounded_text<'a>(text: &'a str, label: &str, limit: usize) -> Result<&'a str, String> {
    if text.trim().is_empty() || text.len() > limit || text.chars().any(char::is_control) {
        return Err(format!("{label} 응답 형식을 확인할 수 없습니다."));
    }
    Ok(text)
}

// 의도적으로 SemVer의 순서 비교를 하지 않는다. build metadata까지 같은 값만 통과한다.
pub(super) fn normalized_version(text: &str) -> Result<String, String> {
    bounded_text(text, "버전", 256)?;
    let version = text.strip_prefix("codex-cli ")
        .or_else(|| text.strip_prefix("codex-app-server ")).unwrap_or(text);
    let numeric = |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())
        && (part.len() == 1 || !part.starts_with('0'));
    let identifiers = |part: &str, prerelease: bool| part.split('.').all(|piece| {
        !piece.is_empty() && piece.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            && (!prerelease || !piece.bytes().all(|c| c.is_ascii_digit()) || numeric(piece))
    });
    let (release, build) = version.split_once('+').map_or((version, None), |(a, b)| (a, Some(b)));
    let (core, prerelease) = release.split_once('-').map_or((release, None), |(a, b)| (a, Some(b)));
    if core.split('.').count() != 3 || !core.split('.').all(numeric)
        || build.is_some_and(|value| !identifiers(value, false))
        || prerelease.is_some_and(|value| !identifiers(value, true)) {
        return Err("버전은 확인된 제품 접두사 또는 완전한 버전 문자열이어야 합니다.".into());
    }
    Ok(version.to_owned())
}

fn executable_version(bytes: &[u8]) -> Result<String, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "실행 파일 버전 응답이 올바른 UTF-8이 아닙니다.")?;
    // --version의 마지막 줄바꿈 한 개만 허용하고 그 외 제어문자는 거부한다.
    let text = text.strip_suffix("\r\n").or_else(|| text.strip_suffix('\n')).unwrap_or(text);
    normalized_version(text)
}

fn field<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str, String> {
    let text = value.get(key).and_then(Value::as_str)
        .ok_or_else(|| format!("공유 서버 응답에 {key} 문자열이 없습니다."))?;
    bounded_text(text, key, limit)
}

fn checkpoint(cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<(), String> {
    check_cancelled(Some(cancelled))?;
    if Instant::now() >= deadline { return Err("런타임 버전 확인 시간이 초과되었습니다.".into()); }
    Ok(())
}

fn supports_passive_status(bytes: &[u8]) -> Result<bool, String> {
    let help = std::str::from_utf8(bytes).map_err(|_| "공유 서버 명령 안내가 올바른 UTF-8이 아닙니다.")?;
    if !help.lines().any(|line| line.trim_start().strip_prefix("Usage:")
        .or_else(|| line.trim_start().strip_prefix("사용법:")).is_some_and(|usage| {
            usage.split_ascii_whitespace().collect::<Vec<_>>().windows(2).any(|pair| pair == ["app-server", "daemon"])
        })) {
        return Err("공유 서버 명령 안내의 사용법을 확인할 수 없습니다.".into());
    }
    let mut lines = help.lines();
    if !lines.any(|line| matches!(line.trim(), "Commands:" | "명령:" | "명령어:")) {
        return Err("공유 서버 명령 목록을 확인할 수 없습니다.".into());
    }
    let rows: Vec<_> = lines.take_while(|line| line.is_empty() || line.starts_with(char::is_whitespace))
        .filter(|line| !line.trim().is_empty()).collect();
    let column = rows.iter().map(|line| line.len() - line.trim_start().len()).min();
    let declares = |name| rows.iter().any(|line| Some(line.len() - line.trim_start().len()) == column
        && line.split_ascii_whitespace().next() == Some(name));
    if declares("status") { Ok(true) } else if declares("version") { Ok(false) }
    else { Err("안전하게 조회할 수 있는 공유 서버 상태 명령이 없습니다.".into()) }
}

// CONC-CANCEL-004: 각 조회 전후와 최종 반환 전에 취소를 확인한다. 모든 조회가
// 같은 deadline을 쓰며, 오류·취소·시간 초과에서 시작/설치/업데이트로 전이하지 않는다.
// 시험 계획: R32/R28·suffix drift·프로토콜 오류는 주입형 unit 경계로 검사한다.
// 실제 프로세스 수명 정리는 기존 command_stdout_until의 소유권 경계를 재사용한다.
fn inspect_commands(
    exe: &OsString, server: &OsString, kind: &str, cancelled: &Arc<AtomicBool>, deadline: Instant,
    mut query: impl FnMut(&OsString, &[&str], Instant) -> Result<Vec<u8>, String>,
) -> Result<RuntimePairStatus, String> {
    checkpoint(cancelled, deadline)?;
    let selected_server = match kind {
        "standalone" => server,
        "cli" => exe,
        _ => return Err("선택한 앱서버 실행 형식을 확인할 수 없습니다.".into()),
    };
    let selected_server_executable = bounded_text(selected_server.to_str()
        .ok_or("앱서버 실행 경로가 올바른 문자열이 아닙니다.")?, "앱서버 실행 경로", 128 * 1024)?.to_owned();
    let mut run = |executable: &OsString, args: &[&str]| {
        checkpoint(cancelled, deadline)?;
        let output = query(executable, args, deadline);
        checkpoint(cancelled, deadline)?;
        output
    };
    let cli_version = executable_version(&run(exe, &["--version"])?)?;
    let selected_server_version = executable_version(&run(selected_server, &["--version"])?)?;
    let mut report = RuntimePairStatus {
        cli_version, selected_server_executable, selected_server_version,
        managed_cli_executable: None, managed_version: None, running_version: None, socket_path: None,
        state: "unavailable".into(), message: None,
    };
    if report.cli_version != report.selected_server_version {
        report.state = "mismatch".into();
        report.message = Some("선택한 CLI와 앱서버의 전체 버전이 다릅니다. 서버를 자동으로 변경하지 않았습니다.".into());
    } else {
        let observed = (|| -> Result<(), String> {
            if !shared::supports_shared(&run(exe, &["app-server", "--help"])?)? {
                report.state = "embedded".into();
                report.message = Some("선택한 CLI는 공유 서버를 지원하지 않아 CLI에 내장된 개별 서버를 사용합니다.".into());
                return Ok(());
            }
            let passive_status = supports_passive_status(&run(exe, &["app-server", "daemon", "--help"])?)?;
            let bytes = if passive_status { run(exe, &["app-server", "daemon", "status", "--json"])? }
                else { run(exe, &["app-server", "daemon", "version"])? };
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "공유 서버 버전 응답이 올바른 JSON이 아닙니다.".to_owned())?;
            if !value.is_object() { return Err("공유 서버 버전 응답이 객체가 아닙니다.".into()); }
            let state = field(&value, "status", 64)?;
            let stopped = state == "stopped" && passive_status;
            let unconfirmed = state == "unknown" && passive_status;
            match state {
                "running" => {}
                "stopped" if passive_status => {}
                "unknown" if passive_status => {
                    let reason = field(&value, "reason", 4096)?;
                    report.message = Some(format!("공유 서버의 상태를 확인하지 못했습니다: {reason}"));
                }
                // legacy version은 Running만 반환한다. 실패를 stopped로 추정하지 않는다.
                _ => return Err("공유 서버의 실행 상태를 확인하지 못했습니다. 중지 상태로 추정하지 않았습니다.".into()),
            }
            let reported_cli = normalized_version(field(&value, "cliVersion", 256)?)?;
            // Passive stopped explicitly reports null when no managed package is installed.
            // Missing fields and non-string values in every other state remain errors.
            let managed = if stopped && value.get("managedCodexVersion") == Some(&Value::Null) { None }
                else { Some(normalized_version(field(&value, "managedCodexVersion", 256)?)?) };
            let running = if stopped {
                if value.get("appServerVersion") != Some(&Value::Null) {
                    return Err("공유 서버의 중지 상태와 실행 버전이 서로 맞지 않습니다.".into());
                }
                None
            } else if unconfirmed && value.get("appServerVersion") == Some(&Value::Null) { None }
                else { Some(normalized_version(field(&value, "appServerVersion", 256)?)?) };
            let managed_path = field(&value, "managedCodexPath", 128 * 1024)?.to_owned();
            let socket = field(&value, "socketPath", 128 * 1024)?.to_owned();
            if !Path::new(&managed_path).is_absolute() || !Path::new(&socket).is_absolute() {
                return Err("공유 서버 실행 파일과 소켓 경로는 절대 경로여야 합니다.".into());
            }
            if reported_cli != report.cli_version {
                return Err("공유 서버 조회가 보고한 CLI 버전이 선택한 실행 파일 버전과 다릅니다.".into());
            }
            report.managed_cli_executable = Some(managed_path);
            report.socket_path = Some(socket);
            report.managed_version = managed.clone();
            report.running_version = running.clone();
            if unconfirmed {
                // 검증된 패키지 정보만 보존한다. unknown을 중지나 실행 중으로 추정하지 않는다.
                report.state = "unconfirmed".into();
                if managed.as_deref() != Some(report.cli_version.as_str())
                    || running.as_deref().is_some_and(|version| version != report.cli_version) {
                    if let Some(message) = report.message.as_mut() {
                        message.push_str("; 관리 중이거나 관측된 서버 버전이 선택한 버전과 다릅니다. 서버 전환 확인이 필요합니다.");
                    }
                }
            } else if stopped {
                report.state = "stopped".into();
                report.message = Some(match managed.as_deref() {
                    None => "공유 서버 패키지가 미설치 상태입니다. 선택한 패키지의 별도 준비가 필요합니다.".into(),
                    Some(version) if version == report.cli_version =>
                        "공유 서버가 중지되어 있습니다. 선택한 버전과 관리 버전은 같습니다.".into(),
                    Some(_) => "공유 서버가 중지되어 있으며 관리 버전이 선택한 버전과 다릅니다. 서버 전환 확인이 필요합니다.".into(),
                });
            } else if managed.as_deref() != Some(report.cli_version.as_str()) || running.as_deref() != Some(report.cli_version.as_str()) {
                report.state = "mismatch".into();
                report.message = Some("선택한 버전과 관리 중이거나 실행 중인 서버의 전체 버전이 다릅니다. 서버 전환 확인이 필요합니다.".into());
            } else {
                report.state = "matched".into();
            }
            Ok(())
        })();
        if let Err(error) = observed {
            report.message = Some(match report.message.take() {
                Some(reason) => format!("{reason}; {error}"),
                None => error,
            });
        }
    }
    checkpoint(cancelled, deadline)?;
    Ok(report)
}

pub(crate) fn inspect(exe: &OsString, server: &OsString, kind: &str, cancelled: &Arc<AtomicBool>) -> Result<RuntimePairStatus, String> {
    inspect_until(exe, server, kind, cancelled, Instant::now() + Duration::from_secs(20))
}

pub(super) fn inspect_until(exe: &OsString, server: &OsString, kind: &str, cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<RuntimePairStatus, String> {
    checkpoint(cancelled, deadline)?;
    let cwd = env::current_dir().map_err(|error| format!("런타임 확인 폴더를 조회할 수 없습니다: {error}"))?;
    inspect_commands(exe, server, kind, cancelled, deadline, |executable, args, deadline| {
        extensions::command_stdout_until(executable, &cwd,
            &args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(), deadline, Some(cancelled))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const R32: &str = "0.166.0+native-r32.20261101";
    const R28: &str = "0.165.0+native-r28.20261029";
    const R33: &str = "0.166.0+native-r33.20261102";

    fn app_server_help(shared: bool) -> Vec<u8> {
        if shared {
            b"Usage: codex app-server [OPTIONS] [COMMAND]\n\nCommands:\n  daemon  Manage server\n  proxy   Relay\n\nOptions:\n  -h, --help\n".to_vec()
        } else {
            b"Usage: codex app-server [OPTIONS]\n\nOptions:\n  -h, --help\n".to_vec()
        }
    }

    fn daemon_help(passive: bool) -> Vec<u8> {
        format!("Usage: codex app-server daemon [OPTIONS] <COMMAND>\n\nCommands:\n  start    Start existing\n  version  Read version\n{}  help     Print help\n\nOptions:\n  -h, --help\n", if passive { "  status   Read passive state\n" } else { "" }).into_bytes()
    }

    fn status(managed: &str, running: &str) -> Value {
        let root = env::temp_dir().join("runtime-pair-fixture");
        json!({"status":"running", "cliVersion":R32, "managedCodexVersion":managed,
            "appServerVersion":running, "managedCodexPath":root.join("codex.exe"), "socketPath":root.join("server.sock")})
    }
    fn inspect_fixture(cli: &str, server: &str, daemon: Result<Vec<u8>, String>) -> (Result<RuntimePairStatus, String>, Vec<String>) {
        inspect_fixture_help(cli, server, Ok(daemon_help(false)), daemon)
    }
    fn inspect_fixture_help(cli: &str, server: &str, help: Result<Vec<u8>, String>, daemon: Result<Vec<u8>, String>) -> (Result<RuntimePairStatus, String>, Vec<String>) {
        inspect_fixture_all_help(cli, server, Ok(app_server_help(true)), help, daemon)
    }
    fn inspect_fixture_all_help(cli: &str, server: &str, app_help: Result<Vec<u8>, String>, help: Result<Vec<u8>, String>, daemon: Result<Vec<u8>, String>) -> (Result<RuntimePairStatus, String>, Vec<String>) {
        let mut calls = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        let result = inspect_commands(&OsString::from("cli.exe"), &OsString::from("server.exe"), "standalone",
            &Arc::new(AtomicBool::new(false)), deadline, |exe, args, received| {
                assert_eq!(received, deadline, "각 명령에 별도 20초를 부여하면 안 됨");
                calls.push(format!("{} {}", exe.to_string_lossy(), args.join(" ")));
                match (exe.to_str().unwrap(), args) {
                    ("cli.exe", ["--version"]) => Ok(format!("codex-cli {cli}\n").into_bytes()),
                    ("server.exe", ["--version"]) => Ok(format!("codex-app-server {server}\r\n").into_bytes()),
                    ("cli.exe", ["app-server", "--help"]) => app_help.clone(),
                    ("cli.exe", ["app-server", "daemon", "--help"]) => help.clone(),
                    ("cli.exe", ["app-server", "daemon", "version"]) => daemon.clone(),
                    ("cli.exe", ["app-server", "daemon", "status", "--json"]) => daemon.clone(),
                    _ => panic!("읽기 전용 버전 조회 이외 명령 금지: {args:?}"),
                }
            });
        (result, calls)
    }

    #[test]
    fn exact_patch_suffix_match_is_required_at_all_three_boundaries() {
        for (managed, running, expected) in [(R32, R32, "matched"), (R28, R28, "mismatch"),
            (R32, R28, "mismatch"), (R28, R32, "mismatch"),
            ("0.166.0+native-r31.20261101", R32, "mismatch"),
            (R32, "0.166.0+native-r32.20261102", "mismatch")] {
            let (report, calls) = inspect_fixture(R32, R32, Ok(serde_json::to_vec(&status(managed, running)).unwrap()));
            let report = report.unwrap();
            assert_eq!(report.state, expected, "managed={managed}, running={running}");
            assert_eq!(report.cli_version, R32);
            assert_eq!(report.managed_version.as_deref(), Some(managed));
            assert_eq!(report.running_version.as_deref(), Some(running));
            assert_eq!(calls, ["cli.exe --version", "server.exe --version", "cli.exe app-server --help", "cli.exe app-server daemon --help", "cli.exe app-server daemon version"]);
        }
    }

    #[test]
    fn selected_server_mismatch_is_reported_without_daemon_mutation_or_probe() {
        let (report, calls) = inspect_fixture(R32, R28, Err("조회하면 안 됨".into()));
        let report = report.unwrap();
        assert_eq!(report.state, "mismatch");
        assert_eq!(report.selected_server_version, R28);
        assert_eq!(calls, ["cli.exe --version", "server.exe --version"]);
    }

    #[test]
    fn cli_kind_uses_the_selected_cli_for_both_executable_versions() {
        let mut calls = Vec::new();
        let report = inspect_commands(&OsString::from("cli.exe"), &OsString::from("unused-server.exe"), "cli",
            &Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20), |exe, args, _| {
                assert_eq!(exe, &OsString::from("cli.exe"));
                calls.push(args.join(" "));
                match args {
                    ["--version"] => Ok(format!("codex-cli {R32}\n").into_bytes()),
                    ["app-server", "--help"] => Ok(app_server_help(true)),
                    ["app-server", "daemon", "--help"] => Ok(daemon_help(false)),
                    ["app-server", "daemon", "version"] => Ok(serde_json::to_vec(&status(R32, R32)).unwrap()),
                    _ => panic!("변경 명령 금지"),
                }
            }).unwrap();
        assert_eq!(report.state, "matched");
        assert_eq!(report.selected_server_executable, "cli.exe");
        assert_eq!(calls, ["--version", "--version", "app-server --help", "app-server daemon --help", "app-server daemon version"]);
    }

    #[test]
    fn failed_or_unknown_daemon_query_never_falls_back_to_start_or_update() {
        for response in [Err("fixture 조회 실패".into()), Ok(b"{partial".to_vec()), Ok(b"null".to_vec()),
            Ok(br#"{"status":"notRunning"}"#.to_vec()), Ok(br#"{"status":"started"}"#.to_vec()),
            Ok(br#"{"status":"unknown"}"#.to_vec())] {
            let (report, calls) = inspect_fixture(R32, R32, response);
            let report = report.unwrap();
            assert_eq!(report.state, "unavailable");
            assert!(report.message.is_some());
            assert_eq!(calls.len(), 5);
            assert_eq!(calls.last().unwrap(), "cli.exe app-server daemon version");
        }
    }

    #[test]
    fn daemon_versions_and_paths_are_required_and_bounded() {
        for key in ["cliVersion", "managedCodexVersion", "appServerVersion", "managedCodexPath", "socketPath", "status"] {
            for invalid in [Value::Null, json!(42), json!(""), json!("not-a-version"), json!("bad\nresponse"), json!("\u{1b}[32mvalue")] {
                let mut value = status(R32, R32); value[key] = invalid;
                let (report, _) = inspect_fixture(R32, R32, Ok(serde_json::to_vec(&value).unwrap()));
                assert_eq!(report.unwrap().state, "unavailable", "field={key}");
            }
            let mut value = status(R32, R32); value.as_object_mut().unwrap().remove(key);
            assert_eq!(inspect_fixture(R32, R32, Ok(serde_json::to_vec(&value).unwrap())).0.unwrap().state, "unavailable");
        }
        for key in ["managedCodexPath", "socketPath"] {
            let mut value = status(R32, R32); value[key] = json!("relative/path");
            assert_eq!(inspect_fixture(R32, R32, Ok(serde_json::to_vec(&value).unwrap())).0.unwrap().state, "unavailable");
        }
        let mut value = status(R32, R32); value["cliVersion"] = json!(R28);
        let report = inspect_fixture(R32, R32, Ok(serde_json::to_vec(&value).unwrap())).0.unwrap();
        assert_eq!(report.state, "unavailable");
        assert!(report.message.unwrap().contains("CLI 버전"));
    }

    #[test]
    fn versions_reject_unknown_prefixes_partial_versions_and_control_characters() {
        for valid in [R32, "codex-cli 0.166.0+native-r32.20261101", "codex-app-server 1.2.3-alpha.1+build.005"] {
            assert!(normalized_version(valid).is_ok(), "{valid}");
        }
        for invalid in ["", "1", "1.2", "01.2.3", "1.2.3.4", "v1.2.3", "other 1.2.3", "codex-cli codex-cli 1.2.3",
            "1.2.3-", "1.2.3-01", "1.2.3+", "1.2.3+build..1", "1.2.3+build+other", " 1.2.3", "1.2.3 ",
            "1.2.3\n", "1.2.3\t", "1.2.3\u{1b}[0m", "1.2.3\0"] {
            assert!(normalized_version(invalid).is_err(), "{invalid:?}");
        }
        for invalid in [b"1.2.3\n\n".as_slice(), b"1.2.3\r", b"1.2.3\nextra", &[0xff]] {
            assert!(executable_version(invalid).is_err());
        }
        assert!(normalized_version(&format!("1.2.3+{}", "x".repeat(256))).is_err());
    }

    #[test]
    fn cancellation_before_during_and_after_last_query_is_not_a_success() {
        for cancel_at in [0, 1, 2, 3, 4, 5] {
            let cancelled = Arc::new(AtomicBool::new(cancel_at == 0));
            let mut calls = 0;
            let report = inspect_commands(&OsString::from("cli.exe"), &OsString::from("server.exe"), "standalone",
                &cancelled, Instant::now() + Duration::from_secs(20), |_, args, _| {
                    calls += 1;
                    if calls == cancel_at { cancelled.store(true, Ordering::Release); }
                    if args == ["--version"] { Ok(R32.as_bytes().to_vec()) }
                    else if args == ["app-server", "--help"] { Ok(app_server_help(true)) }
                    else if args == ["app-server", "daemon", "--help"] { Ok(daemon_help(false)) }
                    else { Ok(serde_json::to_vec(&status(R32, R32)).unwrap()) }
                });
            assert!(report.is_err(), "cancel_at={cancel_at}");
            assert_eq!(calls, cancel_at);
        }
    }

    #[test]
    fn expired_deadline_or_invalid_kind_does_not_query_and_probe_failures_stop() {
        let cancelled = Arc::new(AtomicBool::new(false));
        for (kind, deadline) in [("standalone", Instant::now()), ("unknown", Instant::now() + Duration::from_secs(20))] {
            assert!(inspect_commands(&OsString::from("cli"), &OsString::from("server"), kind, &cancelled, deadline,
                |_, _, _| panic!("입력 오류 또는 시간 초과 뒤 명령 금지")).is_err());
        }
        for fail_at in [1, 2] {
            let mut calls = 0;
            assert!(inspect_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", &cancelled,
                Instant::now() + Duration::from_secs(20), |_, _, _| {
                    calls += 1;
                    if calls == fail_at { Err("fixture 실행 파일 조회 실패".into()) } else { Ok(R32.as_bytes().to_vec()) }
                }).is_err());
            assert_eq!(calls, fail_at);
        }
    }

    #[test]
    fn passive_status_distinguishes_running_stopped_and_unknown_without_inference() {
        for (state, managed, running, expected) in [("running", R33, Some(R33), "matched"),
            ("running", R28, Some(R28), "mismatch"), ("stopped", R33, None, "stopped"),
            ("stopped", R28, None, "stopped"), ("unknown", R33, None, "unavailable")] {
            let mut value = status(managed, R33);
            value["status"] = json!(state); value["cliVersion"] = json!(R33);
            value["appServerVersion"] = json!(running); value["reason"] = Value::Null;
            let (report, calls) = inspect_fixture_help(R33, R33, Ok(daemon_help(true)), Ok(serde_json::to_vec(&value).unwrap()));
            let report = report.unwrap();
            assert_eq!(report.state, expected, "state={state}, managed={managed}");
            if state == "stopped" {
                assert_eq!(report.managed_version.as_deref(), Some(managed));
                assert!(report.running_version.is_none());
                assert!(report.managed_cli_executable.is_some() && report.socket_path.is_some());
            }
            assert_eq!(calls.last().unwrap(), "cli.exe app-server daemon status --json");
            assert_eq!(calls.len(), 5);
        }
    }

    fn unconfirmed_status(managed: &str, running: Option<&str>) -> Value {
        let mut value = status(managed, R33);
        value["status"] = json!("unknown"); value["cliVersion"] = json!(R33);
        value["appServerVersion"] = json!(running);
        value["reason"] = json!("socketProbeFailed: failed to connect: os error 10061");
        value
    }

    #[test]
    fn passive_unknown_preserves_verified_metadata_without_inferring_stopped_or_starting() {
        for (managed, running) in [(R33, None), (R28, None), (R33, Some(R33)), (R33, Some(R28))] {
            let value = unconfirmed_status(managed, running);
            let (report, calls) = inspect_fixture_help(R33, R33, Ok(daemon_help(true)),
                Ok(serde_json::to_vec(&value).unwrap()));
            let report = report.unwrap();
            assert_eq!(report.state, "unconfirmed");
            assert_eq!(report.managed_version.as_deref(), Some(managed));
            assert_eq!(report.running_version.as_deref(), running);
            assert_eq!(report.managed_cli_executable.as_deref(), value["managedCodexPath"].as_str());
            assert_eq!(report.socket_path.as_deref(), value["socketPath"].as_str());
            let message = report.message.unwrap();
            assert!(message.contains(value["reason"].as_str().unwrap()));
            assert_eq!(message.contains("서버 전환 확인이 필요합니다"), managed != R33 || running.is_some_and(|version| version != R33));
            assert_eq!(calls, ["cli.exe --version", "server.exe --version", "cli.exe app-server --help",
                "cli.exe app-server daemon --help", "cli.exe app-server daemon status --json"]);
        }
        // 오류 문자열을 분류하지 않는다. 다른 사유도 동일한 엄격한 메타데이터 검사를 받는다.
        let mut value = unconfirmed_status(R33, None);
        value["reason"] = json!("processStarting");
        let report = inspect_fixture_help(R33, R33, Ok(daemon_help(true)),
            Ok(serde_json::to_vec(&value).unwrap())).0.unwrap();
        assert_eq!(report.state, "unconfirmed");
        assert!(report.message.unwrap().contains("processStarting"));
    }

    #[test]
    fn passive_unknown_requires_complete_consistent_metadata_and_explicit_null_running_version() {
        let base = unconfirmed_status(R33, None);
        let mut invalid_values = Vec::new();
        for key in ["status", "cliVersion", "managedCodexVersion", "managedCodexPath", "socketPath", "reason"] {
            for invalid in [Value::Null, json!(42), json!(""), json!("bad\nresponse"), json!("\u{1b}[32mvalue")] {
                let mut value = base.clone(); value[key] = invalid;
                invalid_values.push((key, value));
            }
        }
        for (key, invalid) in [("cliVersion", json!(R28)), ("managedCodexVersion", json!("not-a-version")),
            ("managedCodexPath", json!("relative/codex.exe")), ("socketPath", json!("relative/server.sock")),
            ("appServerVersion", json!(false)), ("appServerVersion", json!("not-a-version")),
            ("reason", json!("x".repeat(4097)))] {
            let mut value = base.clone(); value[key] = invalid;
            invalid_values.push((key, value));
        }
        for key in ["status", "cliVersion", "managedCodexVersion", "managedCodexPath", "socketPath", "appServerVersion", "reason"] {
            let mut value = base.clone(); value.as_object_mut().unwrap().remove(key);
            invalid_values.push((key, value));
        }
        for (key, value) in invalid_values {
            let (report, calls) = inspect_fixture_help(R33, R33, Ok(daemon_help(true)),
                Ok(serde_json::to_vec(&value).unwrap()));
            let report = report.unwrap();
            assert_eq!(report.state, "unavailable", "field={key}, value={value}");
            assert!(report.managed_cli_executable.is_none() && report.managed_version.is_none()
                && report.running_version.is_none() && report.socket_path.is_none(), "field={key}");
            assert!(report.message.is_some());
            assert_eq!(calls.len(), 5);
            assert_eq!(calls.last().unwrap(), "cli.exe app-server daemon status --json");
        }
        assert_eq!(inspect_fixture(R33, R33, Ok(serde_json::to_vec(&base).unwrap())).0.unwrap().state,
            "unavailable", "legacy version에는 unknown 메타데이터 계약이 없다");
    }

    #[test]
    fn passive_unknown_does_not_bypass_cancellation_after_status_query() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut calls = 0;
        let result = inspect_commands(&OsString::from("cli.exe"), &OsString::from("server.exe"), "standalone",
            &cancelled, deadline, |_, args, received| {
                calls += 1;
                assert_eq!(received, deadline);
                match args {
                    ["--version"] => Ok(R33.as_bytes().to_vec()),
                    ["app-server", "--help"] => Ok(app_server_help(true)),
                    ["app-server", "daemon", "--help"] => Ok(daemon_help(true)),
                    ["app-server", "daemon", "status", "--json"] => {
                        cancelled.store(true, Ordering::Release);
                        Ok(serde_json::to_vec(&unconfirmed_status(R33, None)).unwrap())
                    }
                    _ => panic!("읽기 전용 조회 이외 명령 금지"),
                }
            });
        assert!(result.is_err());
        assert_eq!(calls, 5);
    }

    #[test]
    fn stopped_requires_explicit_version_fields_matching_cli_probe_and_absolute_paths() {
        let mut base = status(R33, R33);
        base["status"] = json!("stopped"); base["cliVersion"] = json!(R33); base["appServerVersion"] = Value::Null;
        for managed in [json!(R33), Value::Null] {
            base["managedCodexVersion"] = managed;
            for (key, invalid) in [("managedCodexVersion", json!(42)), ("managedCodexVersion", json!("")),
                ("managedCodexVersion", json!("not-a-version")), ("managedCodexPath", Value::Null),
                ("managedCodexPath", json!("relative/codex.exe")), ("socketPath", Value::Null),
                ("socketPath", json!("relative/server.sock")), ("cliVersion", json!(R32)),
                ("appServerVersion", json!(R33)), ("appServerVersion", json!(false))] {
                let mut value = base.clone(); value[key] = invalid;
                let report = inspect_fixture_help(R33, R33, Ok(daemon_help(true)), Ok(serde_json::to_vec(&value).unwrap())).0.unwrap();
                assert_eq!(report.state, "unavailable", "field={key}");
            }
            for key in ["managedCodexVersion", "appServerVersion", "managedCodexPath", "socketPath", "cliVersion"] {
                let mut value = base.clone(); value.as_object_mut().unwrap().remove(key);
                assert_eq!(inspect_fixture_help(R33, R33, Ok(daemon_help(true)), Ok(serde_json::to_vec(&value).unwrap())).0.unwrap().state, "unavailable", "missing={key}");
            }
        }
    }

    #[test]
    fn passive_stopped_with_explicit_null_versions_reports_uninstalled_without_mutation() {
        let mut value = status(R33, R33);
        value["status"] = json!("stopped"); value["cliVersion"] = json!(R33);
        value["managedCodexVersion"] = Value::Null; value["appServerVersion"] = Value::Null;
        value["reason"] = Value::Null;
        let bytes = serde_json::to_vec(&value).unwrap();
        let (report, calls) = inspect_fixture_help(R33, R33, Ok(daemon_help(true)), Ok(bytes.clone()));
        let report = report.unwrap();
        assert_eq!(report.state, "stopped");
        assert!(report.managed_version.is_none() && report.running_version.is_none());
        assert_eq!(report.managed_cli_executable.as_deref(), value["managedCodexPath"].as_str());
        assert_eq!(report.socket_path.as_deref(), value["socketPath"].as_str());
        assert!(report.message.unwrap().contains("미설치"));
        assert_eq!(calls, ["cli.exe --version", "server.exe --version", "cli.exe app-server --help",
            "cli.exe app-server daemon --help", "cli.exe app-server daemon status --json"]);
        // Legacy version has no passive stopped contract, even with explicit nulls.
        assert_eq!(inspect_fixture(R33, R33, Ok(bytes)).0.unwrap().state, "unavailable");
    }

    #[test]
    fn passive_running_requires_present_non_null_versions() {
        for key in ["managedCodexVersion", "appServerVersion"] {
            for invalid in [Value::Null, json!(false), json!("not-a-version")] {
                let mut value = status(R33, R33); value["cliVersion"] = json!(R33); value[key] = invalid;
                assert_eq!(inspect_fixture_help(R33, R33, Ok(daemon_help(true)),
                    Ok(serde_json::to_vec(&value).unwrap())).0.unwrap().state, "unavailable", "field={key}");
            }
            let mut value = status(R33, R33); value["cliVersion"] = json!(R33);
            value.as_object_mut().unwrap().remove(key);
            assert_eq!(inspect_fixture_help(R33, R33, Ok(daemon_help(true)),
                Ok(serde_json::to_vec(&value).unwrap())).0.unwrap().state, "unavailable", "missing={key}");
        }
    }

    #[test]
    fn help_failure_is_not_legacy_and_status_is_an_exact_command_declaration() {
        for help in [Err("fixture help 실패".into()), Ok(b"unrecognized".to_vec()),
            Ok(b"Usage: codex app-server daemon [OPTIONS] <COMMAND>\n\nOptions:\n  -h, --help\n".to_vec())] {
            let (report, calls) = inspect_fixture_help(R33, R33, help, Err("다른 명령을 조회하면 안 됨".into()));
            assert_eq!(report.unwrap().state, "unavailable");
            assert_eq!(calls.len(), 4);
        }
        let korean = String::from_utf8(daemon_help(true)).unwrap().replace("Commands:", "명령어:");
        assert!(supports_passive_status(korean.as_bytes()).unwrap());
        let description = String::from_utf8(daemon_help(false)).unwrap().replace("  version  Read version", "  version  Read version\n      status is mentioned only here\n  status-extra Other");
        assert!(!supports_passive_status(description.as_bytes()).unwrap());
        let mut unknown = status(R33, R33);
        unknown["status"] = json!("unknown"); unknown["managedCodexVersion"] = Value::Null;
        unknown["appServerVersion"] = Value::Null; unknown["reason"] = json!("starting record remains");
        let (report, calls) = inspect_fixture_help(R33, R33, Ok(daemon_help(true)), Ok(serde_json::to_vec(&unknown).unwrap()));
        let report = report.unwrap();
        assert_eq!(report.state, "unavailable"); assert!(report.managed_version.is_none() && report.running_version.is_none());
        assert!(report.message.unwrap().contains("starting record remains"));
        assert_eq!(calls.last().unwrap(), "cli.exe app-server daemon status --json");
        for response in [Err("fixture status 조회 실패".into()), Ok(b"{partial".to_vec())] {
            let (report, calls) = inspect_fixture_help(R33, R33, Ok(daemon_help(true)), response);
            assert_eq!(report.unwrap().state, "unavailable");
            assert_eq!(calls.len(), 5);
            assert_eq!(calls.last().unwrap(), "cli.exe app-server daemon status --json");
        }
    }

    #[test]
    fn explicitly_unsupported_shared_server_uses_embedded_without_daemon_queries() {
        let (report, calls) = inspect_fixture_all_help(R32, R32, Ok(app_server_help(false)),
            Err("daemon 도움말 조회 금지".into()), Err("daemon 상태 조회 금지".into()));
        let report = report.unwrap();
        assert_eq!(report.state, "embedded");
        assert_eq!(report.cli_version, R32);
        assert_eq!(report.selected_server_version, R32);
        assert!(report.message.unwrap().contains("내장된 개별 서버"));
        assert!(report.managed_cli_executable.is_none() && report.managed_version.is_none()
            && report.running_version.is_none() && report.socket_path.is_none());
        assert_eq!(calls, ["cli.exe --version", "server.exe --version", "cli.exe app-server --help"]);
    }

    #[test]
    fn failed_or_malformed_shared_help_is_not_embedded() {
        for help in [Err("fixture app-server help 실패".into()), Ok(b"invalid help".to_vec()),
            Ok(b"Usage: codex app-server [OPTIONS] [COMMAND]\n\nOptions:\n  -h, --help\n".to_vec()),
            Ok(b"Usage: codex app-server [OPTIONS]\n".to_vec()), Ok(vec![0xff])] {
            let (report, calls) = inspect_fixture_all_help(R32, R32, help,
                Err("daemon 조회 금지".into()), Err("daemon 조회 금지".into()));
            let report = report.unwrap();
            assert_eq!(report.state, "unavailable");
            assert!(report.message.is_some());
            assert_eq!(calls, ["cli.exe --version", "server.exe --version", "cli.exe app-server --help"]);
        }
    }
}
