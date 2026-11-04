//! 전환 준비와 응답 해석만 담당한다. 실행·설치·재시도·세션 종료는 수행하지 않는다.
use super::*;
use std::{fs, path::PathBuf};

const MANIFEST_LIMIT: u64 = 16 * 1024;
const EXECUTABLE_LIMIT: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTransitionPreview {
    pub pair: RuntimePairStatus,
    pub can_apply: bool,
    pub reason: Option<String>,
    pub fingerprint: String,
    pub package_root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTransitionReply {
    pub status: String,
    pub success: bool,
    pub outcome: String,
    pub message: Option<String>,
}

pub(crate) fn command_args() -> Vec<String> {
    ["app-server", "daemon", "update", "--from-cli", "--no-force", "-y"].map(str::to_owned).to_vec()
}

fn checkpoint(cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<(), String> {
    check_cancelled(Some(cancelled))?;
    if Instant::now() >= deadline { return Err("서버 전환 확인 시간이 초과되었습니다.".into()); }
    Ok(())
}

fn bind(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

// 디렉터리 열거 없이 manifest와 두 실행 파일만 읽는다. OS의 동기 open/read 자체를
// 중단하는 보장은 없으며, 각 read 전후에 전체 deadline과 취소를 확인한다.
fn file_hash(path: &Path, cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<Vec<u8>, String> {
    checkpoint(cancelled, deadline)?;
    let mut file = fs::File::open(path).map_err(|error| format!("실행 파일을 확인할 수 없습니다: {error}"))?;
    let before = file.metadata().map_err(|error| format!("실행 파일 정보를 확인할 수 없습니다: {error}"))?;
    if !before.is_file() || before.len() == 0 || before.len() > EXECUTABLE_LIMIT {
        return Err("실행 파일은 크기가 1 GiB 이하인 일반 파일이어야 합니다.".into());
    }
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut block = [0u8; 64 * 1024];
    loop {
        checkpoint(cancelled, deadline)?;
        let read = file.read(&mut block).map_err(|error| format!("실행 파일 해시 조회 실패: {error}"))?;
        checkpoint(cancelled, deadline)?;
        if read == 0 { break; }
        count += read as u64;
        if count > EXECUTABLE_LIMIT { return Err("확인 중 실행 파일 크기가 1 GiB를 초과했습니다.".into()); }
        hash.update(&block[..read]);
    }
    let after = file.metadata().map_err(|error| format!("실행 파일 정보를 재확인할 수 없습니다: {error}"))?;
    if count != before.len() || after.len() != before.len() || after.modified().ok() != before.modified().ok() {
        return Err("확인 중 실행 파일이 바뀌었습니다. 다시 확인하세요.".into());
    }
    Ok(hash.finalize().to_vec())
}

struct PackageEvidence {
    root: PathBuf, cli: PathBuf, server: PathBuf,
    manifest: Vec<u8>, cli_hash: Vec<u8>, server_hash: Vec<u8>,
}

fn manifest_matches(bytes: &[u8], version: &str) -> Result<(), String> {
    if bytes.len() as u64 > MANIFEST_LIMIT { return Err("패키지 정보 파일이 허용 크기를 넘었습니다. 새 전체 패키지를 선택하세요.".into()); }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "패키지 정보 파일을 읽을 수 없습니다. 새 전체 패키지를 선택하세요.")?;
    let target = match env::consts::ARCH {
        "x86_64" => "x86_64-pc-windows-msvc",
        "aarch64" => "aarch64-pc-windows-msvc",
        _ => return Err("이 Windows 아키텍처의 패키지 전환을 지원하지 않습니다.".into()),
    };
    if value["layoutVersion"].as_u64() != Some(1) || value["entrypoint"] != "bin/codex.exe"
        || value["version"].as_str() != Some(version) || value["target"] != target {
        return Err("패키지 구성·전체 버전·Windows 실행 대상이 선택한 CLI와 일치하지 않습니다. 새 전체 패키지를 선택하세요.".into());
    }
    Ok(())
}

fn package_evidence(exe: &OsString, server: &OsString, kind: &str, version: &str,
    cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<PackageEvidence, String> {
    checkpoint(cancelled, deadline)?;
    let cli = Path::new(exe).canonicalize().map_err(|_| "선택한 CLI의 실제 경로를 확인할 수 없습니다.")?;
    let server = Path::new(server).canonicalize().map_err(|_| "선택한 앱서버의 실제 경로를 확인할 수 없습니다.")?;
    let bin = cli.parent().ok_or("CLI의 bin 폴더가 없습니다.")?;
    let named = |path: &Path, name: &str| path.file_name().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case(name));
    if !named(&cli, "codex.exe") || !named(bin, "bin") || match kind {
        "standalone" => server.parent() != Some(bin) || !named(&server, "codex-app-server.exe"),
        "cli" => server != cli,
        _ => true,
    } {
        return Err("자동 전환은 같은 패키지의 bin/codex.exe와 bin/codex-app-server.exe 조합만 지원합니다. 개별 실행 파일 선택은 유지됩니다.".into());
    }
    let root = bin.parent().ok_or("CLI 패키지 폴더가 없습니다.")?.to_path_buf();
    if root.join("bin/codex.exe").canonicalize().map_err(|_| "패키지 CLI 경로를 확인할 수 없습니다.")? != cli {
        return Err("선택한 CLI가 패키지의 bin/codex.exe와 다릅니다.".into());
    }
    let manifest_path = root.join("codex-package.json").canonicalize()
        .map_err(|_| "필수 정보 파일이 있는 전체 패키지를 선택하세요. 개별 실행 파일은 자동 설치하지 않습니다.")?;
    if manifest_path.parent() != Some(root.as_path()) { return Err("패키지 정보 파일이 패키지 밖을 가리킵니다.".into()); }
    checkpoint(cancelled, deadline)?;
    let file = fs::File::open(manifest_path).map_err(|error| format!("패키지 정보 파일 조회 실패: {error}"))?;
    let metadata = file.metadata().map_err(|error| format!("패키지 정보 조회 실패: {error}"))?;
    if !metadata.is_file() || metadata.len() > MANIFEST_LIMIT { return Err("패키지 정보 파일 형식이나 크기를 확인할 수 없습니다. 새 전체 패키지를 선택하세요.".into()); }
    let mut manifest = Vec::new();
    file.take(MANIFEST_LIMIT + 1).read_to_end(&mut manifest).map_err(|error| format!("패키지 정보 파일 읽기 실패: {error}"))?;
    checkpoint(cancelled, deadline)?;
    manifest_matches(&manifest, version)?;
    let cli_hash = file_hash(&cli, cancelled, deadline)?;
    let server_hash = if server == cli { cli_hash.clone() } else { file_hash(&server, cancelled, deadline)? };
    checkpoint(cancelled, deadline)?;
    Ok(PackageEvidence { root, cli, server, manifest, cli_hash, server_hash })
}

fn supports_safe_update(help: &[u8]) -> Result<bool, String> {
    let from_cli = help_supports_option(help, "--from-cli")?;
    let no_force = help_supports_option(help, "--no-force")?;
    let text = std::str::from_utf8(help).map_err(|_| "전환 도움말이 올바른 UTF-8이 아닙니다.")?;
    let options = text.lines().skip_while(|line| !matches!(line.trim(), "Options:" | "옵션:")).skip(1)
        .take_while(|line| line.is_empty() || line.starts_with(char::is_whitespace));
    let short_column = options.clone().filter(|line| line.trim_start().starts_with('-'))
        .map(|line| line.len() - line.trim_start().len()).min();
    let short_yes = options.clone().any(|line| Some(line.len() - line.trim_start().len()) == short_column
        && matches!(line.split_ascii_whitespace().next(), Some("-y" | "-y,")));
    // 실제 실행 인자가 -y로 고정되어 있으므로 --yes만 선언한 CLI는 통과시키지 않는다.
    Ok(from_cli && no_force && short_yes)
}

// 현재 UI가 사용하는 preview 경계의 주입점이다. 시험은 실제 daemon/실행 파일을
// 호출하지 않고 동일 명령·deadline과 패키지 증거의 결속을 검증한다.
fn preview_commands(exe: &OsString, server: &OsString, kind: &str, pair: RuntimePairStatus,
    cancelled: &Arc<AtomicBool>, deadline: Instant,
    package: impl FnOnce() -> Result<PackageEvidence, String>,
    mut query: impl FnMut(&[&str], Instant) -> Result<Vec<u8>, String>,
) -> Result<RuntimeTransitionPreview, String> {
    checkpoint(cancelled, deadline)?;
    let mut hash = Sha256::new();
    bind(&mut hash, b"opendiy-runtime-transition-v1");
    bind(&mut hash, exe.to_string_lossy().as_bytes());
    bind(&mut hash, server.to_string_lossy().as_bytes());
    bind(&mut hash, kind.as_bytes());
    bind(&mut hash, &serde_json::to_vec(&pair).map_err(|_| "전환 버전 상태를 결속할 수 없습니다.")?);
    let mut report = RuntimeTransitionPreview { pair, can_apply: false, reason: None, fingerprint: String::new(), package_root: None };
    let candidate = (|| -> Result<(), String> {
        if report.pair.cli_version != report.pair.selected_server_version {
            return Err("선택한 CLI와 앱서버의 전체 버전을 먼저 맞추세요.".into());
        }
        if report.pair.state == "embedded" {
            return Err("이 CLI는 내장된 개별 서버를 사용하므로 공유 서버를 전환할 필요가 없습니다.".into());
        }
        if report.pair.state == "matched" {
            return Err("선택한 CLI와 관리·실행 서버의 버전이 이미 같습니다. 전환하지 않았습니다.".into());
        }
        if report.pair.state == "stopped" && report.pair.managed_version.is_none()
            && report.pair.running_version.is_none() && report.pair.managed_cli_executable.is_some()
            && report.pair.socket_path.is_some() {
            return Err("공유 서버 패키지가 미설치 상태입니다. 현재 CLI의 안전한 서버 전환 명령은 첫 설치를 지원하지 않으므로 선택한 패키지의 별도 준비가 필요합니다.".into());
        }
        if !matches!(report.pair.state.as_str(), "mismatch" | "stopped")
            || report.pair.managed_cli_executable.is_none() || report.pair.managed_version.is_none()
            || (report.pair.state == "mismatch" && report.pair.running_version.is_none())
            || (report.pair.state == "stopped" && report.pair.running_version.is_some()) || report.pair.socket_path.is_none() {
            return Err("현재 관리·실행 서버의 상태를 확인하지 못해 전환을 준비할 수 없습니다.".into());
        }
        // Check this cheap prerequisite before reading/hashing large executables.
        // Unsupported CLIs must report the missing capability, not a hash timeout.
        let help = query(&["app-server", "daemon", "update", "--help"], deadline)?;
        checkpoint(cancelled, deadline)?;
        bind(&mut hash, &help);
        if !supports_safe_update(&help)? {
            return Err("선택한 CLI는 작업을 강제로 종료하지 않는 서버 전환을 지원하지 않습니다. 새 전체 패키지를 선택하세요.".into());
        }
        let evidence = package()?;
        checkpoint(cancelled, deadline)?;
        for path in [&evidence.root, &evidence.cli, &evidence.server] {
            bind(&mut hash, path.to_str().ok_or("패키지 경로가 올바른 문자열이 아닙니다.")?.as_bytes());
        }
        bind(&mut hash, &evidence.manifest);
        bind(&mut hash, &evidence.cli_hash);
        bind(&mut hash, &evidence.server_hash);
        report.package_root = Some(evidence.root.to_str().ok_or("패키지 폴더가 올바른 문자열이 아닙니다.")?.to_owned());
        report.can_apply = true;
        // 이 preview는 전체 패키지 무결성을 인증하지 않는다. 트리 검증은 CLI 책임이다.
        report.reason = Some("확인 후 작업을 강제로 종료하지 않고 서버를 전환합니다. 종료 요청 후에는 취소할 수 없으며 응답이 끊겨도 서버가 나중에 종료될 수 있습니다.".into());
        Ok(())
    })();
    if let Err(reason) = candidate { report.reason = Some(reason); }
    checkpoint(cancelled, deadline)?;
    report.fingerprint = format!("{:x}", hash.finalize());
    Ok(report)
}

pub(crate) fn preview(exe: &OsString, server: &OsString, kind: &str, cancelled: &Arc<AtomicBool>) -> Result<RuntimeTransitionPreview, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let pair = runtime_pair::inspect_until(exe, server, kind, cancelled, deadline)?;
    checkpoint(cancelled, deadline)?;
    let version = pair.cli_version.clone();
    let cwd = env::current_dir().map_err(|error| format!("전환 확인 폴더 조회 실패: {error}"))?;
    preview_commands(exe, server, kind, pair, cancelled, deadline,
        || package_evidence(exe, server, kind, &version, cancelled, deadline),
        |args, deadline| extensions::command_stdout_until(exe, &cwd,
            &args.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>(), deadline, Some(cancelled)))
}

pub(crate) fn parse_update_output(bytes: &[u8]) -> Result<RuntimeTransitionReply, String> {
    if bytes.len() > 64 * 1024 { return Err("서버 전환 응답이 크기 상한을 초과했습니다. 결과는 확인되지 않았으며 자동 재시도하지 마세요.".into()); }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "서버 전환 응답이 올바른 JSON이 아닙니다. 결과는 확인되지 않았으며 자동 재시도하지 마세요.")?;
    let status = value.get("status").and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control))
        .ok_or("서버 전환 상태가 누락되거나 올바르지 않습니다. 결과를 재확인하세요.")?.to_owned();
    let message = match value.get("message") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.len() <= 4096 && !text.chars().any(char::is_control) => Some(text.clone()),
        _ => return Err("서버 전환 설명 형식이 올바르지 않습니다. 결과를 재확인하세요.".into()),
    };
    if status == "updated" {
        return Ok(RuntimeTransitionReply { status, success: true, outcome: "updated".into(), message });
    }
    // 요청/ACK 유실·timeout은 이전 서버 생존을 보장하지 않는다. 늦은 drain도 가능하다.
    let detail = match status.as_str() {
        "shutdownUnconfirmed" | "shutdownTimedOut" | "shutdownOutcomeUnknown" =>
            "종료 결과가 확인되지 않았습니다. 서버가 나중에 종료될 수 있으므로 상태를 확인하고 자동 재시도하지 마세요.",
        _ => "알 수 없는 서버 전환 응답입니다. 성공으로 처리하지 않았으며 자동 재시도하지 마세요.",
    };
    Ok(RuntimeTransitionReply { status, success: false, outcome: "unknown".into(),
        message: Some(match message { Some(message) if !message.is_empty() => format!("{detail} {message}"), _ => detail.into() }) })
}

#[cfg(test)]
mod tests {
    use super::*;
    const VERSION: &str = "0.166.0+native-r33.20261102";
    fn pair() -> RuntimePairStatus {
        RuntimePairStatus { cli_version: VERSION.into(), selected_server_executable: "server.exe".into(),
            selected_server_version: VERSION.into(), managed_cli_executable: Some("managed-cli.exe".into()),
            managed_version: Some("0.165.0+native-r28.20261029".into()), running_version: Some("0.165.0+native-r28.20261029".into()),
            socket_path: Some("fixture.sock".into()), state: "mismatch".into(), message: None }
    }
    fn help() -> Vec<u8> {
        b"Usage: codex app-server daemon update [OPTIONS]\n\nOptions:\n      --from-cli\n      --no-force\n  -y, --yes\n  -h, --help\n".to_vec()
    }
    fn help_without(line: &str) -> Vec<u8> {
        String::from_utf8(help()).unwrap().replace(line, "").into_bytes()
    }
    fn evidence() -> PackageEvidence {
        PackageEvidence { root: PathBuf::from("package"), cli: PathBuf::from("package/bin/codex.exe"),
            server: PathBuf::from("package/bin/codex-app-server.exe"), manifest: b"manifest-bytes".to_vec(), cli_hash: vec![1;32], server_hash: vec![2;32] }
    }
    fn fixture(pair: RuntimePairStatus, evidence: PackageEvidence, help: Vec<u8>) -> RuntimeTransitionPreview {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut calls = 0;
        let report = preview_commands(&OsString::from("cli.exe"), &OsString::from("server.exe"), "standalone", pair,
            &Arc::new(AtomicBool::new(false)), deadline, || Ok(evidence), |args, received| {
                assert_eq!(args, ["app-server", "daemon", "update", "--help"]);
                assert_eq!(received, deadline);
                calls += 1;
                Ok(help.clone())
            }).unwrap();
        assert!(calls <= 1, "자동 retry 금지");
        report
    }

    #[test]
    fn command_plan_is_fixed_and_help_is_the_only_preview_command() {
        assert_eq!(command_args(), ["app-server", "daemon", "update", "--from-cli", "--no-force", "-y"]);
        let report = fixture(pair(), evidence(), help());
        assert!(report.can_apply);
        assert_eq!(report.fingerprint.len(), 64);
        assert!(report.reason.unwrap().contains("나중에 종료"));
    }

    #[test]
    fn preview_binds_all_candidate_and_observed_generation_evidence() {
        let baseline = fixture(pair(), evidence(), help()).fingerprint;
        for field in 0..7 {
            let mut pair = pair();
            match field {
                0 => pair.cli_version.push('x'), 1 => pair.selected_server_version.push('x'),
                2 => pair.managed_cli_executable = Some("other".into()), 3 => pair.managed_version = Some("other".into()),
                4 => pair.running_version = Some("other".into()), 5 => pair.socket_path = Some("other".into()),
                _ => pair.selected_server_executable.push('x'),
            }
            assert_ne!(fixture(pair, evidence(), help()).fingerprint, baseline);
        }
        for field in 0..4 {
            let mut evidence = evidence(); let mut help = help();
            match field { 0 => evidence.manifest.push(b'x'), 1 => evidence.cli_hash[0] ^= 1,
                2 => evidence.server_hash[0] ^= 1, _ => help.extend_from_slice(b"\nDifferent help\n") }
            assert_ne!(fixture(pair(), evidence, help).fingerprint, baseline);
        }
        assert_eq!(fixture(pair(), evidence(), help()).fingerprint, baseline);
    }

    #[test]
    fn embedded_runtime_never_inspects_or_transitions_a_shared_package() {
        let mut embedded = pair();
        embedded.state = "embedded".into();
        embedded.managed_cli_executable = None; embedded.managed_version = None;
        embedded.running_version = None; embedded.socket_path = None;
        let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", embedded,
            &Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20),
            || panic!("내장 개별 서버는 공유 패키지를 읽으면 안 됨"),
            |_, _| panic!("내장 개별 서버는 전환 도움말도 조회하면 안 됨")).unwrap();
        assert!(!report.can_apply);
        assert!(report.reason.unwrap().contains("전환할 필요가 없습니다"));
    }

    #[test]
    fn unknown_pair_skips_help_and_unsupported_update_skips_package_reads() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut unknown = pair(); unknown.state = "unavailable".into();
        let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", unknown,
            &cancelled, Instant::now() + Duration::from_secs(20), || panic!("unknown pair 패키지 읽기 금지"),
            |_, _| panic!("unknown pair 명령 금지")).unwrap();
        assert!(!report.can_apply);
        let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", pair(),
            &cancelled, Instant::now() + Duration::from_secs(20), || panic!("미지원 CLI의 큰 실행 파일 읽기 금지"),
            |args, _| { assert_eq!(args, ["app-server", "daemon", "update", "--help"]); Ok(help_without("      --no-force\n")) }).unwrap();
        assert!(!report.can_apply);
        assert!(report.reason.unwrap().contains("지원하지 않습니다"));
        let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", pair(),
            &cancelled, Instant::now() + Duration::from_secs(20), || Err("완전한 패키지가 아님".into()),
            |args, _| { assert_eq!(args, ["app-server", "daemon", "update", "--help"]); Ok(help()) }).unwrap();
        assert!(!report.can_apply);
        assert_eq!(report.reason.as_deref(), Some("완전한 패키지가 아님"));
    }

    #[test]
    fn matched_is_blocked_and_confirmed_stopped_can_transition_without_running_version() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut matched = pair(); matched.state = "matched".into();
        let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", matched,
            &cancelled, Instant::now() + Duration::from_secs(20), || panic!("버전 일치 뒤 파일 읽기 금지"),
            |_, _| panic!("버전 일치 뒤 명령 금지")).unwrap();
        assert!(!report.can_apply);
        assert!(report.reason.unwrap().contains("이미 같습니다"));
        let baseline = fixture(pair(), evidence(), help()).fingerprint;
        for managed in [VERSION, "0.165.0+native-r28.20261029"] {
            let mut stopped = pair(); stopped.state = "stopped".into(); stopped.running_version = None;
            stopped.managed_version = Some(managed.into());
            let report = fixture(stopped, evidence(), help());
            assert!(report.can_apply);
            assert_ne!(report.fingerprint, baseline);
        }
        let mut invalid = pair(); invalid.state = "stopped".into();
        assert!(!fixture(invalid, evidence(), help()).can_apply);
    }

    #[test]
    fn uninstalled_stopped_requires_separate_preparation_without_update_or_package_reads() {
        let mut stopped = pair(); stopped.state = "stopped".into();
        stopped.running_version = None; stopped.managed_version = None;
        let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", stopped,
            &Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20),
            || panic!("첫 설치 미지원이면 패키지 읽기 금지"),
            |_, _| panic!("첫 설치를 위한 자동 시작·전환 명령 금지")).unwrap();
        assert!(!report.can_apply);
        assert!(report.package_root.is_none());
        assert_eq!(report.fingerprint.len(), 64);
        assert!(report.reason.unwrap().contains("첫 설치를 지원하지 않으므로"));
    }

    #[test]
    fn mismatch_with_missing_managed_or_running_version_remains_blocked() {
        for missing_managed in [true, false] {
            let mut missing = pair();
            if missing_managed { missing.managed_version = None; } else { missing.running_version = None; }
            let report = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", missing,
                &Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20),
                || panic!("불명 버전 패키지 읽기 금지"), |_, _| panic!("불명 버전 명령 금지")).unwrap();
            assert!(!report.can_apply);
        }
    }

    #[test]
    fn exact_no_force_declaration_is_required_without_fallback() {
        for invalid in [help_without("      --no-force\n"),
            b"Usage: codex app-server daemon update [OPTIONS]\n\nOptions:\n      --from-cli\n      --no-force-other\n          description: --no-force\n  -y, --yes\n  -h, --help\n".to_vec()] {
            assert!(!fixture(pair(), evidence(), invalid).can_apply);
        }
        let short_only = b"Usage: codex app-server daemon update [OPTIONS]\n\nOptions:\n      --from-cli\n      --no-force\n  -y\n  -h, --help\n";
        assert!(supports_safe_update(short_only).unwrap());
        assert!(!supports_safe_update(&help_without("  -y, --yes\n")).unwrap());
        let long_only = String::from_utf8(help()).unwrap().replace("  -y, --yes\n", "      --yes\n          description -y\n");
        assert!(!supports_safe_update(long_only.as_bytes()).unwrap());
    }

    #[test]
    fn safe_update_accepts_actual_korean_help_with_exact_guards() {
        let help = include_str!("../../tests/fixtures/opendiy-r36-update-help.ko.txt");
        assert!(supports_safe_update(help.as_bytes()).unwrap());
        assert!(supports_safe_update(help.replace('\n', "\r\n").as_bytes()).unwrap());
        assert!(!supports_safe_update(help.replace("--no-force", "--no-force-other").as_bytes()).unwrap());
        assert!(!supports_safe_update(help.replace("  -y, --yes", "      --yes").as_bytes()).unwrap());
    }

    #[test]
    fn manifest_requires_exact_layout_version_entrypoint_target_and_patch() {
        let target = if env::consts::ARCH == "aarch64" { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" };
        let valid = json!({"layoutVersion":1,"entrypoint":"bin/codex.exe","target":target,"version":VERSION});
        assert!(manifest_matches(&serde_json::to_vec(&valid).unwrap(), VERSION).is_ok());
        for (key, invalid) in [("layoutVersion", json!(2)), ("entrypoint", json!("codex.exe")),
            ("target", json!("x86_64-unknown-linux-gnu")), ("version", json!("0.166.0+native-r32.20261101"))] {
            let mut value = valid.clone(); value[key] = invalid;
            assert!(manifest_matches(&serde_json::to_vec(&value).unwrap(), VERSION).is_err());
        }
        assert!(manifest_matches(&vec![b' '; MANIFEST_LIMIT as usize + 1], VERSION).is_err());
    }

    #[test]
    fn shutdown_failures_are_unknown_and_updated_is_the_only_success() {
        for status in ["updated", "shutdownUnconfirmed", "shutdownTimedOut", "shutdownOutcomeUnknown", "noUpdate", "unknown"] {
            let reply = parse_update_output(&serde_json::to_vec(&json!({"status":status,"message":"fixture"})).unwrap()).unwrap();
            assert_eq!(reply.success, status == "updated");
            assert_eq!(reply.outcome, if status == "updated" { "updated" } else { "unknown" });
            if !reply.success { assert!(reply.message.unwrap().contains("자동 재시도")); }
        }
        for invalid in [b"{partial".as_slice(), b"null", br#"{"status":12}"#, br#"{"status":"updated\n"}"#,
            br#"{"status":"updated","message":false}"#] { assert!(parse_update_output(invalid).is_err()); }
    }

    #[test]
    fn cancellation_and_deadline_prevent_preview_success() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let result = preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", pair(), &cancelled,
            Instant::now() + Duration::from_secs(20), || Ok(evidence()), |_, _| {
                cancelled.store(true, Ordering::Release); Ok(help())
            });
        assert!(result.is_err());
        assert!(preview_commands(&OsString::from("cli"), &OsString::from("server"), "standalone", pair(),
            &Arc::new(AtomicBool::new(false)), Instant::now(), || panic!("시간 초과 뒤 파일 읽기 금지"),
            |_, _| panic!("시간 초과 뒤 명령 금지")).is_err());
    }

    #[test]
    fn package_uses_one_canonical_bin_and_hashes_the_selected_files() {
        struct Fixture(PathBuf);
        impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let fixture = Fixture(env::temp_dir().join(format!("runtime-transition-{}", Uuid::new_v4())));
        let root = &fixture.0;
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("other/bin")).unwrap();
        let cli = root.join("bin/codex.exe");
        let server = root.join("bin/codex-app-server.exe");
        fs::write(&cli, b"abc").unwrap();
        fs::write(&server, b"def").unwrap();
        fs::write(root.join("other/bin/codex-app-server.exe"), b"def").unwrap();
        let target = if env::consts::ARCH == "aarch64" { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" };
        let manifest = serde_json::to_vec(&json!({"layoutVersion":1,"entrypoint":"bin/codex.exe","target":target,"version":VERSION})).unwrap();
        fs::write(root.join("codex-package.json"), &manifest).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let check = |server: &Path, kind: &str| package_evidence(&cli.clone().into_os_string(), &server.as_os_str().to_owned(),
            kind, VERSION, &cancelled, Instant::now() + Duration::from_secs(20));
        let evidence = check(&server, "standalone").unwrap();
        assert_eq!(evidence.manifest, manifest);
        assert_eq!(evidence.root, root.canonicalize().unwrap());
        assert_eq!(evidence.cli_hash, Sha256::digest(b"abc").to_vec());
        assert_eq!(evidence.server_hash, Sha256::digest(b"def").to_vec());
        assert!(check(&root.join("other/bin/codex-app-server.exe"), "standalone").is_err());
        assert!(check(&server, "cli").is_err());
        let same = check(&cli, "cli").unwrap();
        assert_eq!(same.cli_hash, same.server_hash);
        fs::write(root.join("codex-package.json"), vec![b' '; MANIFEST_LIMIT as usize + 1]).unwrap();
        assert!(check(&server, "standalone").is_err());
    }
}
