//! Stable launcher 해석만 담당한다. 설정과 기존 세션은 바꾸지 않으며 매 요청을
//! 실제 패키지 경로에 고정한다. receipt/파일 SHA 검증은 producer가 매번 수행한다.
use super::*;
use std::path::{Component, PathBuf};

const LAUNCHER_NAME: &str = "opendiy-codex-launcher.exe";
const RESPONSE_LIMIT: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ResolvedRuntimeSource {
    pub executable: OsString,
    pub server_executable: OsString,
    pub server_kind: String,
    pub source_manifest_sha256: Option<String>,
}

pub(crate) fn is_launcher(exe: &OsString) -> bool {
    named(Path::new(exe), LAUNCHER_NAME)
}

fn named(path: &Path, name: &str) -> bool {
    path.file_name().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case(name))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LauncherResponse {
    schema: u64,
    installation_root: String,
    package_root: String,
    manifest_sha256: String,
    version: String,
    revision: u64,
    source_commit: String,
    cli_path: String,
    cli_sha256: String,
    app_server_path: String,
    app_server_sha256: String,
}

fn bounded(text: &str, limit: usize) -> bool {
    !text.trim().is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
}

fn digest(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|value| value.is_ascii_hexdigit())
}

// Cargo 버전의 전체 build metadata를 보존한다. 버전 번호로 기능 지원은 추론하지 않는다.
fn full_version(text: &str) -> bool {
    runtime_pair::normalized_version(text).is_ok_and(|version| version == text)
}

fn response_path(text: &str) -> Result<PathBuf, String> {
    if !bounded(text, 32 * 1024) { return Err("런처가 반환한 실행 경로 형식이 올바르지 않습니다.".into()); }
    let path = PathBuf::from(text);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir)) {
        return Err("런처는 패키지의 명확한 절대 경로를 반환해야 합니다.".into());
    }
    Ok(path)
}

fn checkpoint(cancelled: &Arc<AtomicBool>, deadline: Instant) -> Result<(), String> {
    check_cancelled(Some(cancelled))?;
    if Instant::now() >= deadline { return Err("실행 패키지 확인 시간이 초과되었습니다.".into()); }
    Ok(())
}

// CONC-CANCEL-004: 조회·경로 확인 전후와 반환 전에 같은 deadline/취소를 검사한다.
// OS의 동기 canonicalize 자체는 중단할 수 없다. 실제 프로세스 회수는 기존 runner 소유다.
fn resolve_commands(exe: &OsString, server: &OsString, kind: &str, automatic_server: bool,
    cancelled: &Arc<AtomicBool>, deadline: Instant,
    mut query: impl FnMut(&OsString, &[&str], Instant) -> Result<Vec<u8>, String>,
    mut canonicalize: impl FnMut(&Path) -> Result<PathBuf, String>,
) -> Result<ResolvedRuntimeSource, String> {
    checkpoint(cancelled, deadline)?;
    if !is_launcher(exe) {
        let resolved = ResolvedRuntimeSource { executable: exe.clone(), server_executable: server.clone(),
            server_kind: kind.into(), source_manifest_sha256: None };
        checkpoint(cancelled, deadline)?;
        return Ok(resolved);
    }
    let mut canonical = |path: &Path| {
        checkpoint(cancelled, deadline)?;
        let result = canonicalize(path);
        checkpoint(cancelled, deadline)?;
        result
    };
    let launcher = canonical(Path::new(exe))?;
    if !launcher.is_absolute() || !named(&launcher, LAUNCHER_NAME) {
        return Err("선택한 런처의 실제 경로를 확인할 수 없습니다.".into());
    }
    let expected_root = launcher.parent().ok_or("선택한 런처의 설치 폴더가 없습니다.")?;
    let bytes = query(exe, &["--opendiy-resolve-json"], deadline)?;
    checkpoint(cancelled, deadline)?;
    if bytes.len() > RESPONSE_LIMIT { return Err("런처의 패키지 정보 응답이 크기 상한을 초과했습니다.".into()); }
    let text = std::str::from_utf8(&bytes).map_err(|_| "런처의 패키지 정보가 올바른 UTF-8이 아닙니다.")?;
    let text = text.strip_suffix("\r\n").or_else(|| text.strip_suffix('\n')).unwrap_or(text);
    if text.contains('\r') || text.contains('\n') { return Err("런처가 단일 JSON 응답을 반환하지 않았습니다.".into()); }
    let info: LauncherResponse = serde_json::from_str(text).map_err(|_| "런처의 패키지 정보 형식이 올바르지 않습니다.")?;
    if info.schema != 1 || info.revision == 0 || !full_version(&info.version)
        || !digest(&info.manifest_sha256, 64) || !digest(&info.cli_sha256, 64) || !digest(&info.app_server_sha256, 64)
        || !(digest(&info.source_commit, 40) || digest(&info.source_commit, 64)) {
        return Err("런처의 패키지 식별 정보·버전·검증값이 올바르지 않습니다.".into());
    }
    let root = canonical(&response_path(&info.installation_root)?)?;
    if root != expected_root { return Err("런처가 다른 설치 폴더의 패키지를 반환했습니다.".into()); }
    let versions = canonical(&root.join("versions"))?;
    if versions.parent() != Some(root.as_path()) || !named(&versions, "versions") {
        return Err("런처의 버전 폴더가 설치 폴더 밖을 가리킵니다.".into());
    }
    let package = canonical(&response_path(&info.package_root)?)?;
    if package.parent() != Some(versions.as_path()) { return Err("런처의 패키지가 버전 폴더의 직접 하위 경로가 아닙니다.".into()); }
    let bin = canonical(&package.join("bin"))?;
    if bin.parent() != Some(package.as_path()) || !named(&bin, "bin") {
        return Err("런처의 실행 파일 폴더가 패키지 밖을 가리킵니다.".into());
    }
    let cli = canonical(&response_path(&info.cli_path)?)?;
    let resolved_server = canonical(&response_path(&info.app_server_path)?)?;
    if cli.parent() != Some(bin.as_path()) || !named(&cli, "codex.exe")
        || resolved_server.parent() != Some(bin.as_path()) || !named(&resolved_server, "codex-app-server.exe") {
        return Err("런처가 같은 패키지의 CLI와 앱서버를 반환하지 않았습니다.".into());
    }
    checkpoint(cancelled, deadline)?;
    Ok(ResolvedRuntimeSource { executable: cli.into_os_string(),
        server_executable: if automatic_server { resolved_server.into_os_string() } else { server.clone() },
        server_kind: if automatic_server { "standalone".into() } else { kind.into() },
        source_manifest_sha256: Some(info.manifest_sha256.to_ascii_lowercase()) })
}

pub(crate) fn resolve(exe: &OsString, server: &OsString, kind: &str, automatic_server: bool,
    cancelled: &Arc<AtomicBool>) -> Result<ResolvedRuntimeSource, String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    resolve_commands(exe, server, kind, automatic_server, cancelled, deadline, |exe, args, deadline| {
        let cwd = env::current_dir().map_err(|error| format!("실행 패키지 확인 폴더 조회 실패: {error}"))?;
        extensions::command_stdout_until(exe, &cwd, &args.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>(), deadline, Some(cancelled))
    }, |path| path.canonicalize().map_err(|error| format!("실행 패키지의 실제 경로 확인 실패: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    const VERSION: &str = "0.166.0+native-r33.20261102";
    fn root() -> PathBuf { env::temp_dir().join("runtime-source-fixture") }
    fn launcher() -> OsString { root().join(LAUNCHER_NAME).into_os_string() }
    fn response() -> Value {
        let root = root(); let package = root.join("versions/revision-33");
        json!({"schema":1,"installationRoot":root,"packageRoot":package,
            "manifestSha256":"a".repeat(64),"version":VERSION,"revision":33,"sourceCommit":"b".repeat(40),
            "cliPath":package.join("bin/codex.exe"),"cliSha256":"c".repeat(64),
            "appServerPath":package.join("bin/codex-app-server.exe"),"appServerSha256":"d".repeat(64)})
    }
    fn fixture(value: Value, automatic: bool) -> Result<ResolvedRuntimeSource, String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut queries = 0;
        let result = resolve_commands(&launcher(), &OsString::from("manual-server.exe"), "cli", automatic,
            &Arc::new(AtomicBool::new(false)), deadline, |exe, args, received| {
                assert_eq!(exe, &launcher()); assert_eq!(args, ["--opendiy-resolve-json"]); assert_eq!(received, deadline);
                queries += 1; Ok(serde_json::to_vec(&value).unwrap())
            }, |path| Ok(path.to_path_buf()));
        assert_eq!(queries, 1, "고정된 읽기 전용 조회 한 번만 허용");
        result
    }

    #[test]
    fn direct_executables_and_similar_names_are_passthrough_without_queries_or_files() {
        for name in ["codex.exe", "codex-app-server.exe", "other-opendiy-codex-launcher.exe", "opendiy-codex-launcher.exe.backup"] {
            let exe = root().join(name).into_os_string();
            let server = OsString::from("selected-server.exe");
            let result = resolve_commands(&exe, &server, "standalone", true, &Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(20), |_, _, _| panic!("직접 실행 파일 명령 금지"),
                |_| panic!("직접 실행 파일 추가 경로 조회 금지")).unwrap();
            assert_eq!(result, ResolvedRuntimeSource { executable: exe, server_executable: server,
                server_kind: "standalone".into(), source_manifest_sha256: None });
        }
        assert!(is_launcher(&launcher()));
    }

    #[test]
    fn launcher_pins_actual_pair_and_preserves_manual_server() {
        let automatic = fixture(response(), true).unwrap();
        let package = root().join("versions/revision-33/bin");
        assert_eq!(automatic.executable, package.join("codex.exe").into_os_string());
        assert_eq!(automatic.server_executable, package.join("codex-app-server.exe").into_os_string());
        assert_eq!(automatic.server_kind, "standalone");
        assert_eq!(automatic.source_manifest_sha256, Some("a".repeat(64)));
        let manual = fixture(response(), false).unwrap();
        assert_eq!(manual.executable, automatic.executable);
        assert_eq!(manual.server_executable, OsString::from("manual-server.exe"));
        assert_eq!(manual.server_kind, "cli");
        let mut next = response(); next["manifestSha256"] = json!("e".repeat(64));
        assert_ne!(fixture(next, true).unwrap().source_manifest_sha256, automatic.source_manifest_sha256);
        let mut next = response(); let next_package = root().join("versions/revision-34");
        next["packageRoot"] = json!(next_package);
        next["cliPath"] = json!(next_package.join("bin/codex.exe"));
        next["appServerPath"] = json!(next_package.join("bin/codex-app-server.exe"));
        let next = fixture(next, true).unwrap();
        assert_ne!(next.executable, automatic.executable);
        assert_eq!(automatic.executable, package.join("codex.exe").into_os_string());
    }

    #[test]
    fn schema_revision_version_and_digests_fail_closed() {
        for (key, invalid) in [("schema", json!(2)), ("schema", json!(1.0)), ("revision", json!(0)),
            ("revision", json!(-1)), ("revision", json!(1.5)), ("version", json!("codex-cli 0.166.0")),
            ("version", json!("0.166")), ("version", json!("0.166.0+")), ("version", json!("0.166.0\n")),
            ("manifestSha256", json!("a".repeat(63))), ("cliSha256", json!("g".repeat(64))),
            ("appServerSha256", json!("d\n".repeat(32))), ("sourceCommit", json!("unknown"))] {
            let mut value = response(); value[key] = invalid;
            assert!(fixture(value, true).is_err(), "field={key}");
        }
        for key in ["schema", "installationRoot", "packageRoot", "manifestSha256", "version", "revision", "sourceCommit",
            "cliPath", "cliSha256", "appServerPath", "appServerSha256"] {
            let mut value = response(); value.as_object_mut().unwrap().remove(key);
            assert!(fixture(value, true).is_err(), "missing={key}");
        }
    }

    #[test]
    fn paths_must_stay_in_one_direct_package_and_installation() {
        for (key, invalid) in [("installationRoot", root().join("other")), ("packageRoot", root().join("elsewhere/package")),
            ("packageRoot", root().join("versions/nested/package")), ("cliPath", root().join("versions/other/bin/codex.exe")),
            ("appServerPath", root().join("versions/revision-33/bin/not-server.exe")),
            ("cliPath", PathBuf::from("relative/codex.exe")), ("packageRoot", root().join("versions/../outside"))] {
            let mut value = response(); value[key] = json!(invalid);
            assert!(fixture(value, true).is_err(), "field={key}");
        }
        let mut value = response(); value["cliPath"] = json!("bad\0path");
        assert!(fixture(value, true).is_err());
        let mut value = response(); value["appServerPath"] = json!("x".repeat(32 * 1024 + 1));
        assert!(fixture(value, true).is_err());
    }

    #[test]
    fn malformed_oversized_multiline_or_failed_query_never_falls_back() {
        for output in [Err("fixture launcher 실패".into()), Ok(b"{partial".to_vec()), Ok(b"null".to_vec()),
            Ok(vec![b'x'; RESPONSE_LIMIT + 1]), Ok(b"{}\n{}".to_vec()),
            Ok(br#"{"schema":1,"schema":1}"#.to_vec())] {
            let mut calls = 0;
            let result = resolve_commands(&launcher(), &OsString::from("server"), "cli", true,
                &Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20), |_, args, _| {
                    assert_eq!(args, ["--opendiy-resolve-json"]); calls += 1; output.clone()
                }, |path| Ok(path.to_path_buf()));
            assert!(result.is_err()); assert_eq!(calls, 1);
        }
    }

    #[test]
    fn canonical_path_escape_and_resolution_failure_are_rejected() {
        for escape in [false, true] {
            let result = resolve_commands(&launcher(), &OsString::from("server"), "cli", true,
                &Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20), |_, _, _| Ok(serde_json::to_vec(&response()).unwrap()),
                |path| if path == root().join("versions/revision-33/bin") {
                    if escape { Ok(root().join("outside/bin")) } else { Err("fixture canonical 실패".into()) }
                } else { Ok(path.to_path_buf()) });
            assert!(result.is_err());
        }
    }

    #[test]
    fn cancellation_before_query_during_query_and_during_path_check_is_not_success() {
        for cancel_at in [0, 1, 2] {
            let cancelled = Arc::new(AtomicBool::new(cancel_at == 0));
            let mut queries = 0;
            let result = resolve_commands(&launcher(), &OsString::from("server"), "cli", true, &cancelled,
                Instant::now() + Duration::from_secs(20), |_, _, _| {
                    queries += 1; if cancel_at == 1 { cancelled.store(true, Ordering::Release); }
                    Ok(serde_json::to_vec(&response()).unwrap())
                }, |path| {
                    if cancel_at == 2 && path == root().join("versions/revision-33/bin/codex-app-server.exe") {
                        cancelled.store(true, Ordering::Release);
                    }
                    Ok(path.to_path_buf())
                });
            assert!(result.is_err()); assert_eq!(queries, if cancel_at == 0 { 0 } else { 1 });
        }
        assert!(resolve_commands(&launcher(), &OsString::from("server"), "cli", true,
            &Arc::new(AtomicBool::new(false)), Instant::now(), |_, _, _| panic!("시간 초과 뒤 명령 금지"),
            |_| panic!("시간 초과 뒤 경로 조회 금지")).is_err());
    }
}
