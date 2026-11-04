use super::*;

fn startup_help() -> Vec<u8> {
    b"Usage: fixture app-server [OPTIONS] [COMMAND]\n\nCommands:\n  daemon  Manage daemon\n  proxy  Relay\n\nOptions:\n  -h, --help\n          Print help\n".to_vec()
}
fn startup_start_help() -> Vec<u8> {
    b"Usage: fixture app-server daemon start [OPTIONS]\n\nOptions:\n      --existing-installation\n          Preserve the installed server and settings\n      --first-installation\n          Recheck pristine state under the operation lock\n  -h, --help\n          Print help\n".to_vec()
}
fn startup_status(status: &str, socket: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"status":status,"socketPath":socket,"appServerVersion":"fixture"})).unwrap()
}
fn startup_installation(status: &str, managed: Value, running: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"status":status,"managedCodexVersion":managed,"appServerVersion":running})).unwrap()
}
fn startup_commands_case(replies: Vec<Result<Vec<u8>, String>>, started: Result<Vec<u8>, String>) -> (Result<Option<Value>, String>, Vec<String>) {
    let calls = std::cell::RefCell::new(Vec::new());
    let mut replies = std::collections::VecDeque::from(replies);
    let result = prepare_runtime_commands(
        |args| { calls.borrow_mut().push(args.join(" ")); replies.pop_front().expect("추가 조회 금지") },
        |mode| { calls.borrow_mut().push(format!("start {}", mode.option())); started },
        |path| fs::symlink_metadata(path),
    );
    assert!(replies.is_empty(), "예정된 상태 확인을 생략하면 안 된다");
    (result, calls.into_inner())
}
#[test]
fn startup_reuses_running_server_without_install_or_start_and_keeps_legacy_path() {
    let socket = env::current_dir().unwrap().join("startup-fixture.sock").to_str().unwrap().to_owned();
    let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Ok(startup_status("running", &socket))], Err("시작 금지".into()));
    assert_eq!(result.unwrap().unwrap()["status"], "running");
    assert_eq!(calls, ["app-server --help", "app-server daemon start --help", "app-server daemon version"]);
    let legacy = b"Usage: fixture app-server [OPTIONS]\n\nOptions:\n  -h, --help\n          Print help\n".to_vec();
    let (result, calls) = startup_commands_case(vec![Ok(legacy)], Err("시작 금지".into()));
    assert!(result.unwrap().is_none());
    assert_eq!(calls, ["app-server --help"]);
    let (result, calls) = startup_commands_case(vec![Ok(b"invalid help".to_vec())], Err("시작 금지".into()));
    assert!(result.is_err());
    assert_eq!(calls, ["app-server --help"]);
}
#[test]
fn startup_reuses_different_server_version_without_version_equality_gate() {
    let socket = env::current_dir().unwrap().join("startup-fixture.sock");
    let running = json!({"status":"running","socketPath":socket,
        "cliVersion":"0.0.0-r35","managedCodexVersion":"0.0.0-r34","appServerVersion":"0.0.0-r33"});
    let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Ok(serde_json::to_vec(&running).unwrap())], Err("시작 금지".into()));
    assert_eq!(result.unwrap().unwrap(), running);
    assert_eq!(calls, ["app-server --help", "app-server daemon start --help", "app-server daemon version"]);
}
#[test]
fn startup_starts_installed_server_once_then_verifies_ready_for_both_start_results() {
    let socket = env::current_dir().unwrap().join("startup-fixture.sock").to_str().unwrap().to_owned();
    for status in ["started", "alreadyRunning"] {
        let (result, calls) = startup_commands_case(
            vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()),
                Ok(startup_installation("stopped", json!("existing-version"), Value::Null)), Ok(startup_status("running", &socket))],
            Ok(startup_status(status, &socket)),
        );
        assert!(result.unwrap().is_some());
        assert_eq!(calls, ["app-server --help", "app-server daemon start --help", "app-server daemon version", "app-server daemon status --json", "start --existing-installation", "app-server daemon version"]);
    }
}
#[test]
fn startup_uses_existing_embedded_path_when_preserving_option_is_not_declared() {
    for help in [
        b"Usage: fixture app-server daemon start [OPTIONS]\n\nOptions:\n  -h, --help\n          Use --existing-installation if available\n".to_vec(),
        b"Usage: fixture app-server daemon start [OPTIONS]\n\nOptions:\n      --existing-installation-extra\n  -h, --help\n          Print help\n".to_vec(),
    ] {
        let mut replies = std::collections::VecDeque::from([Ok(startup_help()), Ok(help)]);
        let mut calls = Vec::new();
        let result = prepare_runtime_commands(
            |args| { calls.push(args.join(" ")); replies.pop_front().expect("version·상태 조회 금지") },
            |_| panic!("보존 미지원 CLI의 daemon start 금지"),
            |_| panic!("보존 미지원 CLI의 metadata 조회 금지"),
        );
        assert!(result.unwrap().is_none());
        assert!(replies.is_empty());
        assert_eq!(calls, ["app-server --help", "app-server daemon start --help"]);
    }
}
#[test]
fn startup_confirmed_missing_package_uses_locked_first_installation() {
    let home = env::current_dir().unwrap().join("target").join(format!("startup-fresh-{}", Uuid::new_v4()));
    fs::create_dir_all(&home).unwrap();
    let socket = home.join("app-server-control/app-server-control.sock").to_str().unwrap().to_owned();
    for relative in ["packages/app-server-daemon/current/bin", "packages/app-server-daemon/current",
        "packages/standalone/current/bin", "packages/standalone/current"] {
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let passive = json!({"status":"stopped","managedCodexVersion":null,"appServerVersion":null,
            "socketPath":socket,"managedCodexPath":home.join(relative).join(name)});
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()),
            Ok(serde_json::to_vec(&passive).unwrap()), Ok(startup_status("running", &socket))], Ok(startup_status("started", &socket)));
        assert!(result.unwrap().is_some());
        assert_eq!(calls, ["app-server --help", "app-server daemon start --help", "app-server daemon version", "app-server daemon status --json", "start --first-installation", "app-server daemon version"]);
    }
    fs::remove_dir(&home).unwrap();
}
#[test]
fn startup_first_option_requires_its_own_declaration_and_legacy_fresh_uses_individual_adapter() {
    let home = env::current_dir().unwrap().join("target/startup-old-first-seam");
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let passive = serde_json::to_vec(&json!({"status":"stopped","managedCodexVersion":null,"appServerVersion":null,
        "socketPath":home.join("app-server-control/app-server-control.sock"),
        "managedCodexPath":home.join("packages/app-server-daemon/current/bin").join(name)})).unwrap();
    for declaration in ["", "          Use --first-installation when available\n", "      --first-installation-extra\n"] {
        let help = format!("Usage: fixture app-server daemon start [OPTIONS]\n\nOptions:\n      --existing-installation\n          Preserve installation\n{declaration}  -h, --help\n          Print help\n").into_bytes();
        let replies = || std::collections::VecDeque::from([Ok(startup_help()), Ok(help.clone()), Err("no daemon".into()), Ok(passive.clone())]);
        let mut startup = replies();
        assert!(prepare_runtime_commands(
            |_| startup.pop_front().expect("no extra query"),
            |_| panic!("unguarded daemon start must never run"),
            |_| Err(std::io::ErrorKind::NotFound.into()),
        ).unwrap().is_none());
        assert!(startup.is_empty());
        let mut discovery = replies();
        assert!(existing_runtime_commands(
            |_| discovery.pop_front().expect("no extra query"),
            |_| Err(std::io::ErrorKind::NotFound.into()),
        ).unwrap().is_none(), "session discovery must select the same individual adapter");
        assert!(discovery.is_empty());
        // The same old CLI must still reuse a live server without a new first-start requirement.
        let socket = home.join("app-server-control/app-server-control.sock");
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(help),
            Ok(startup_status("running", socket.to_str().unwrap()))], Err("no start".into()));
        assert!(result.unwrap().is_some()); assert_eq!(calls.len(), 3);
    }
}
#[test]
fn startup_concurrent_installation_refusal_preserves_recovery_and_never_retries_bare_start() {
    let root = env::current_dir().unwrap().join("target").join(format!("startup-first-race-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let passive = serde_json::to_vec(&json!({"status":"stopped","managedCodexVersion":null,"appServerVersion":null,
        "socketPath":root.join("app-server-control/app-server-control.sock"),
        "managedCodexPath":root.join("packages/app-server-daemon/current/bin").join(name)})).unwrap();
    let mut replies = std::collections::VecDeque::from([Ok(startup_help()), Ok(startup_start_help()), Err("no daemon".into()), Ok(passive)]);
    let recovery = root.join("app-server-daemon/loaded-threads.json");
    let mut starts = Vec::new();
    let result = prepare_runtime_commands(
        |_| replies.pop_front().expect("no query after rejected first start"),
        |mode| {
            starts.push(mode);
            // Another lifecycle operation completed after Desktop's empty observation.
            fs::create_dir_all(recovery.parent().unwrap()).unwrap();
            fs::write(&recovery, b"concurrent recovery sentinel").unwrap();
            Err("first-installation start refused: existing daemon state; no state changed".into())
        },
        |path| fs::symlink_metadata(path),
    );
    assert!(result.unwrap_err().contains("first-installation start refused"));
    assert_eq!(starts, [DaemonStart::First]);
    assert_eq!(DaemonStart::First.option(), "--first-installation");
    assert_eq!(DaemonStart::Existing.option(), "--existing-installation");
    assert_eq!(fs::read(&recovery).unwrap(), b"concurrent recovery sentinel");
    assert!(replies.is_empty());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn legacy_existing_discovery_preserves_live_servers_and_rejects_uncertain_installations() {
    let home = env::current_dir().unwrap().join("target/startup-legacy-discovery");
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let socket = home.join("app-server-control/app-server-control.sock");
    let passive = json!({"status":"stopped","managedCodexVersion":null,"appServerVersion":null,
        "socketPath":socket,"managedCodexPath":home.join("packages/app-server-daemon/current/bin").join(name)});
    let old_help = String::from_utf8(startup_start_help()).unwrap().replace("      --first-installation\n          Recheck pristine state under the operation lock\n", "").into_bytes();
    let running = startup_status("running", socket.to_str().unwrap());
    let mut replies = std::collections::VecDeque::from([Ok(startup_help()), Ok(old_help.clone()), Ok(running)]);
    assert_eq!(existing_runtime_commands(
        |_| replies.pop_front().expect("live daemon must not query status or start"),
        |_| panic!("live daemon must not inspect installation markers"),
    ).unwrap().unwrap()["status"], "running");
    assert!(replies.is_empty());
    let mut unknown = passive.clone(); unknown["status"] = json!("unknown");
    for (status, metadata_case) in [(Ok(serde_json::to_vec(&passive).unwrap()), 1),
        (Ok(serde_json::to_vec(&passive).unwrap()), 2),
        (Ok(serde_json::to_vec(&unknown).unwrap()), 0),
        (Ok(br#"{"status":"stopped"}"#.to_vec()), 0),
        (Err("status Access denied".into()), 0), (Ok(b"malformed".to_vec()), 0)] {
        let mut replies = std::collections::VecDeque::from([Ok(startup_help()), Ok(old_help.clone()), Err("original connection failure".into()), status]);
        let result = existing_runtime_commands(
            |_| replies.pop_front().expect("no extra query or retry"),
            |_| match metadata_case {
                1 => fs::metadata(env::current_dir().unwrap()), // Existing marker.
                2 => Err(std::io::ErrorKind::PermissionDenied.into()),
                _ => panic!("uncertain status must not authorize metadata discovery"),
            },
        );
        assert!(result.is_err(), "existing or uncertain installation must never silently select another adapter");
        assert!(replies.is_empty());
    }
}
#[test]
fn startup_preserves_existing_selection_recovery_and_installation_markers() {
    let root = env::current_dir().unwrap().join("target").join(format!("startup-preserve-{}", Uuid::new_v4()));
    for (index, marker) in ["packages/app-server-daemon/current", "packages/standalone/current",
        "app-server-daemon/settings.json", "app-server-daemon/loaded-threads.json", "app-server-daemon/daemon.pid", "app-server-daemon/daemon.stderr.log",
        "app-server-daemon/daemon-updater.pid", "app-server-daemon/daemon-updater.stderr.log",
        "app-server-daemon/app-server.pid", "app-server-daemon/app-server.stderr.log",
        "app-server-daemon/app-server-updater.pid", "app-server-daemon/app-server-updater.stderr.log"].iter().enumerate() {
        let home = root.join(index.to_string());
        let marker = home.join(marker);
        if marker.file_name() == Some(std::ffi::OsStr::new("current")) {
            fs::create_dir_all(marker.join("bin")).unwrap(); // current만 남고 실행 파일은 사라진 설치.
        } else {
            fs::create_dir_all(marker.parent().unwrap()).unwrap();
            fs::write(&marker, b"owned installation marker").unwrap();
        }
        let recovery = home.join("app-server-daemon/loaded-threads.json");
        // 첫 사례는 감사에서 발견한 current/bin 누락 + 복구 자료 + PID/socket 없음이다.
        if index == 0 {
            fs::create_dir_all(recovery.parent().unwrap()).unwrap();
            fs::write(&recovery, b"owned recovery sentinel").unwrap();
        }
        let socket = home.join("app-server-control/app-server-control.sock");
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let passive = json!({"status":"stopped","managedCodexVersion":null,"appServerVersion":null,
            "socketPath":socket,"managedCodexPath":home.join("packages/app-server-daemon/current/bin").join(name)});
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()),
            Ok(serde_json::to_vec(&passive).unwrap())], Err("선택한 CLI의 설치 오류 원문".into()));
        assert!(result.unwrap_err().contains("선택한 CLI의 설치 오류 원문"));
        assert_eq!(calls.last().unwrap(), "start --existing-installation");
        assert!(fs::symlink_metadata(&marker).is_ok());
        if index == 0 { assert_eq!(fs::read(&recovery).unwrap(), b"owned recovery sentinel"); }
    }
    fs::remove_dir_all(&root).unwrap();
}
#[test]
fn startup_metadata_observation_failure_keeps_preserving_start_and_cli_error() {
    let home = env::current_dir().unwrap().join("target/startup-metadata-seam");
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let passive = json!({"status":"stopped","managedCodexVersion":null,"appServerVersion":null,
        "socketPath":home.join("app-server-control/app-server-control.sock"),
        "managedCodexPath":home.join("packages/app-server-daemon/current/bin").join(name)});
    let mut replies = std::collections::VecDeque::from([Ok(startup_help()), Ok(startup_start_help()),
        Err("연결 없음".into()), Ok(serde_json::to_vec(&passive).unwrap())]);
    let mut observations = 0;
    let result = prepare_runtime_commands(
        |_| replies.pop_front().expect("추가 조회 금지"),
        |mode| { assert_eq!(mode, DaemonStart::Existing); Err("CLI 원래 권한 오류: Access denied".into()) },
        |_| { observations += 1; Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)) },
    );
    assert!(result.unwrap_err().contains("CLI 원래 권한 오류: Access denied"));
    assert_eq!(observations, 1);
    assert!(replies.is_empty());
}
#[test]
fn startup_unrecognized_installation_paths_never_authorize_default_start() {
    let home = env::current_dir().unwrap().join("target/startup-path-seam");
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let valid = json!({"socketPath":home.join("app-server-control/app-server-control.sock"),
        "managedCodexPath":home.join("packages/app-server-daemon/current/bin").join(name)});
    for (key, path) in [("socketPath", Value::Null), ("managedCodexPath", Value::Null),
        ("managedCodexPath", json!("relative/current/bin/codex.exe")),
        ("socketPath", json!(home.join("unrecognized/socket.sock"))),
        ("managedCodexPath", json!(home.join("outside/current/bin").join(name))),
        ("managedCodexPath", json!(home.join("../other/packages/app-server-daemon/current/bin").join(name)))] {
        let mut invalid = valid.clone(); invalid[key] = path;
        assert!(!first_installation(&invalid, |_| panic!("검증하지 않은 경로의 metadata 조회 금지")));
    }
}
#[test]
fn startup_preserves_installation_when_status_query_is_unavailable_or_incomplete() {
    let socket = env::current_dir().unwrap().join("startup-fixture.sock").to_str().unwrap().to_owned();
    for passive in [Err("미지원 명령".into()), Ok(br#"{"status":"stopped"}"#.to_vec()),
        Ok(startup_installation("unknown", json!("installed"), Value::Null)),
        Ok(startup_installation("unknown", Value::Null, json!("running-version"))),
        Ok(startup_installation("unknown", Value::Null, Value::Null)),
        Ok(serde_json::to_vec(&json!({"status":"unknown","managedCodexVersion":null,"appServerVersion":null,
            "reason":"selectedVersionObservationFailed: Access denied"})).unwrap())] {
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()), passive,
            Ok(startup_status("running", &socket))], Ok(startup_status("started", &socket)));
        assert!(result.unwrap().is_some());
        assert!(calls.iter().any(|call| call == "start --existing-installation"));
    }
}
#[test]
fn startup_rejects_malformed_start_help_and_passive_status_without_starting() {
    for help in [Err("start help: Access denied".into()), Ok(b"invalid help".to_vec()), Ok(vec![0xff])] {
        let execution_error = help.as_ref().err().cloned();
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), help], Err("시작 금지".into()));
        let error = result.unwrap_err();
        if let Some(original) = execution_error { assert!(error.contains(&original)); }
        assert_eq!(calls, ["app-server --help", "app-server daemon start --help"]);
    }
    for passive in [b"invalid json".to_vec(), br#"{"status":false}"#.to_vec(),
        startup_installation("stopped", json!(42), Value::Null), startup_installation("unknown", Value::Null, json!(false))] {
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()), Ok(passive)], Err("시작 금지".into()));
        assert!(result.is_err());
        assert_eq!(calls.len(), 4);
    }
}
#[test]
fn shared_management_selection_preserves_app_server_help_execution_and_protocol_errors() {
    for reply in [Err("app-server help: Access denied".into()), Ok(b"invalid help".to_vec()), Ok(vec![0xff])] {
        let execution_error = reply.as_ref().err().cloned();
        let mut reply = Some(reply);
        let mut calls = Vec::new();
        let error = supports_shared_management(|args| {
            calls.push(args.join(" "));
            reply.take().expect("도움말 오류 뒤 추가 조회 금지")
        }).unwrap_err();
        if let Some(original) = execution_error { assert!(error.contains(&original)); }
        assert_eq!(calls, ["app-server --help"]);
    }
}
#[test]
fn startup_never_retries_failed_start_and_rejects_unverified_readiness() {
    let socket = env::current_dir().unwrap().join("startup-fixture.sock").to_str().unwrap().to_owned();
    let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()), Err("조회 미지원".into())], Err("실행 거절".into()));
    assert!(result.unwrap_err().contains("실행 거절"));
    assert_eq!(calls.iter().filter(|call| call.as_str() == "start --existing-installation").count(), 1);
    for ready in [Err("준비 시간 초과".into()), Ok(startup_status("notRunning", &socket)), Ok(startup_status("running", &(socket.clone()+"-other")))] {
        let (result, _) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Err("연결 없음".into()), Err("조회 미지원".into()), ready], Ok(startup_status("started", &socket)));
        assert!(result.is_err());
    }
    for reply in [b"bad json".to_vec(), startup_status("stopped", &socket), startup_status("running", "relative")] {
        let (result, calls) = startup_commands_case(vec![Ok(startup_help()), Ok(startup_start_help()), Ok(reply)], Err("시작 금지".into()));
        assert!(result.is_err());
        assert_eq!(calls.len(), 3, "성공 코드의 잘못된 상태를 시작 허가로 바꾸면 안 된다");
    }
}
#[test]
fn shared_support_requires_declared_commands_and_never_treats_bad_help_as_legacy() {
    let options = "\nOptions:\n  -h, --help\n          Print help\n";
    let header = "Usage: fixture app-server [OPTIONS] [COMMAND]\n\n";
    assert!(supports_shared(format!("{header}Commands:\n  daemon  Manage daemon\n  proxy  Relay\n  help  Print help\n{options}").as_bytes()).unwrap());
    assert!(!supports_shared(format!("{header}Commands:\n  help  Print help\n        daemon proxy are description words\n{options}").as_bytes()).unwrap());
    assert!(!supports_shared(format!("Usage: fixture app-server [OPTIONS]\n{options}").as_bytes()).unwrap());
    assert!(supports_shared(format!("{header}{options}").as_bytes()).is_err());
    assert!(supports_shared(format!("사용법: codex app-server [OPTIONS] [COMMAND]\n\n명령어:\n  daemon  Manage daemon\n  proxy  Relay\n  help  Print help\n{options}").as_bytes()).unwrap());
    assert!(supports_shared(b"not a help document").is_err());
    assert!(supports_shared(&[0xff]).is_err());
}
#[test]
fn shared_resume_has_exact_id_and_no_websocket_token_option() {
    let cwd = env::current_dir().unwrap();
    let socket = cwd.join("fixture.sock");
    let endpoint = SharedEndpoint {exe:"fixture".into(),socket:socket.clone(),stamp:SocketStamp {canonical:socket,created:None,modified:None}};
    let command = endpoint.tui(&cwd, "exact-id").unwrap();
    let args: Vec<_> = command.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(&args[1..3], ["resume", "exact-id"]);
    assert!(args.iter().any(|a| a.starts_with("unix://")));
    assert!(!args.iter().any(|a| a == "--remote-auth-token-env"));
}
#[test]
fn shared_lifecycle_and_turn_bounds_reject_ambiguous_targets() {
    assert!(lifecycle_socket(&json!({"status":"running","socketPath":"relative","appServerVersion":"1"})).is_err());
    assert!(lifecycle_socket(&json!({"status":"stopped"})).is_err());
    assert_eq!(active_turn(&json!({"data":[{"id":"turn-a","status":"inProgress"}]})).unwrap(), Some("turn-a"));
    assert_eq!(active_turn(&json!({"data":[{"id":"old","status":"completed"}]})).unwrap(), None);
    assert!(active_turn(&json!({"data":[{"status":"inProgress"}]})).is_err());
    assert!(active_turn(&json!({"data":[{},{}]})).is_err());
}
fn read_rpc(ws: &mut WebSocket<TcpStream>) -> Value {
    loop { if let Message::Text(text) = ws.read().unwrap() { return serde_json::from_str(&text).unwrap(); } }
}
fn reply(ws: &mut WebSocket<TcpStream>, request: &Value, result: Value) {
    ws.send(Message::Text(json!({"id":request["id"],"result":result}).to_string().into())).unwrap();
}
#[test]
fn stop_pins_original_turn_before_tui_cleanup_and_never_retargets_mobile_turn() {
    let cwd = env::current_dir().unwrap().canonicalize().unwrap();
    let server_cwd = cwd.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
    let worker = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut ws = WebSocket::from_raw_socket(stream, tungstenite::protocol::Role::Server, None);
        let read = read_rpc(&mut ws);
        assert_eq!(read["method"], "thread/read");
        assert_eq!(read["params"], json!({"threadId":"selected-thread","includeTurns":false}));
        reply(&mut ws, &read, json!({"thread":{"id":"selected-thread","cwd":server_cwd,"status":{"type":"active"}}}));
        let list = read_rpc(&mut ws);
        assert_eq!(list["method"], "thread/turns/list");
        assert_eq!(list["params"]["limit"], 1);
        assert_eq!(list["params"]["itemsView"], "summary");
        reply(&mut ws, &list, json!({"data":[{"id":"original-turn","status":"inProgress"}]}));
        // PTY 정리 중 모바일이 새 turn을 시작한 실패 경계다.
        let current_turn = "mobile-new-turn";
        let interrupt = read_rpc(&mut ws);
        assert_eq!(interrupt["method"], "turn/interrupt");
        assert_eq!(interrupt["params"], json!({"threadId":"selected-thread","turnId":"original-turn"}));
        assert_ne!(interrupt["params"]["turnId"], current_turn);
        ws.send(Message::Text(json!({"id":interrupt["id"],"error":{"code":-32600,"message":"expected active original-turn but found mobile-new-turn"}}).to_string().into())).unwrap();
        assert!(ws.read().is_err(), "새 turn 재조회·중단을 재시도하면 안 된다");
        assert_eq!(current_turn, "mobile-new-turn");
    });
    let mut rpc = Rpc {ws:WebSocket::from_raw_socket(stream, tungstenite::protocol::Role::Client, None),next_id:0,cancelled:None,deadline:None};
    let captured = capture_turn(&mut rpc, "selected-thread", &cwd).unwrap();
    assert_eq!(captured.as_deref(), Some("original-turn"));
    assert!(interrupt_exact(&mut rpc, "selected-thread", &cwd, captured.as_deref()).unwrap_err().contains("mobile-new-turn"));
    drop(rpc);
    worker.join().unwrap();
}
#[test]
#[ignore = "격리 CODEX_HOME과 소유 시험 서버가 준비된 때만 명시적으로 실행한다"]
fn real_existing_backend_adapter_uses_one_backend_and_preserves_it() {
    let exe = env::var_os("OPENDIY_SHARED_FIXTURE_EXE").expect("격리 시험 실행 파일이 필요하다");
    let home = PathBuf::from(env::var_os("OPENDIY_SHARED_FIXTURE_HOME").expect("격리 시험 경로가 필요하다"));
    assert_eq!(env::var_os("CODEX_HOME"), Some(home.clone().into_os_string()));
    assert!(!home.join("auth.json").exists(), "사용자 자격증명을 읽으면 안 된다");
    let cwd = home.canonicalize().unwrap();
    let (sender, receiver) = mpsc::channel();
    let events = Arc::new(move |event| { sender.send(event).unwrap(); });
    let session = prepare_with_executable(&exe, &cwd, None, events).unwrap();
    assert!(session.server.is_none() && session.job.is_none(), "외부 서버를 소유하면 안 된다");
    assert!(session.shared.is_some());
    let id = match receiver.recv_timeout(Duration::from_secs(2)).unwrap() { CodexEvent::ThreadId(id) => id, event => panic!("새 대화 ID가 먼저 와야 한다: {event:?}") };
    let args: Vec<_> = session.command.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(&args[1..3], ["resume", &id]);
    let mobile = session.mobile_connection();
    let reply = mobile.request(MobileAction::Status).unwrap();
    assert!(reply.shared && reply.mutations_allowed && !reply.isolated);
    assert_eq!(reply.status.unwrap().status, "disabled");
    let stop = session.shared_control().unwrap().capture_stop(Instant::now()+Duration::from_secs(3)).unwrap();
    stop.finish().unwrap();
    drop(session);
    assert!(mobile.request(MobileAction::Status).is_err(), "종료된 세션의 관리 핸들이 재연결하면 안 된다");
    let endpoint = SharedEndpoint::existing(&exe, &cwd, None).unwrap().expect("공유 서버가 유지되어야 한다");
    let mut proxy = endpoint.open(None).unwrap();
    initialize_proxy(&mut proxy).unwrap();
    let thread = proxy.call("thread/read", json!({"threadId":id,"includeTurns":false})).unwrap();
    assert_eq!(thread["thread"]["id"], id);
}

#[test]
#[ignore = "격리 CODEX_HOME에 공유 서버가 없는 상태에서만 명시적으로 실행한다"]
fn shared_capable_cli_without_backend_fails_without_an_owned_server_fallback() {
    let exe = env::var_os("OPENDIY_SHARED_FIXTURE_EXE").expect("격리 시험 실행 파일이 필요하다");
    let home = PathBuf::from(env::var_os("OPENDIY_SHARED_FIXTURE_HOME").expect("격리 시험 경로가 필요하다"));
    assert_eq!(env::var_os("CODEX_HOME"), Some(home.clone().into_os_string()));
    assert!(!home.join("auth.json").exists());
    let error = prepare_with_executable(&exe, &home, None, Arc::new(|_| {})).err().expect("공유 서버가 없으면 다른 서버로 대체하면 안 된다");
    assert!(error.contains("기존 공유 Codex 서버에 연결할 수 없습니다"), "{error}");
    assert!(error.contains("자동으로 설치하거나 시작하지 않았습니다"), "{error}");
}

#[test]
fn compatibility_reuses_only_live_same_executable_and_socket_declarations_without_rpc() {
    let directory = env::temp_dir().join(format!("opendiy-compatibility-{}", Uuid::new_v4()));
    fs::create_dir(&directory).unwrap();
    let socket = directory.join("fixture.sock"); fs::write(&socket, b"first").unwrap();
    let exe = OsString::from("fixture.exe");
    let endpoint = SharedEndpoint { exe: exe.clone(), socket: socket.clone(), stamp: socket_stamp(&socket).unwrap() };
    let stopped = Arc::new(AtomicBool::new(false));
    let initialized = json!({"userAgent":"fixture-origin/1.2.3 (Linux 6.8.0; x86_64) fixture-client/9.0","supportsSubagentManagement":true,"supportsExpectedTurnInterrupt":false});
    let control = SharedControl { endpoint, thread_id: "own-fixture".into(), cwd: directory.clone(), stopped: stopped.clone(), capabilities: super::super::runtime::observed_capabilities(&initialized) };
    assert_eq!(control.observed_capabilities(&exe).unwrap(), Some(super::super::runtime::observed_capabilities(&initialized).unwrap()));
    // 이미 받은 선언만 보존하며 서버 재조회 없이 누락과 잘못된 값을 구별한다.
    for response in [json!({}), json!({"userAgent":"different-origin/2.0"})] {
        let mut cached = control.clone(); cached.capabilities = super::super::runtime::observed_capabilities(&response);
        assert_eq!(cached.observed_capabilities(&exe).unwrap(), Some(super::super::runtime::observed_capabilities(&response).unwrap()));
    }
    for response in [json!({"userAgent":null}), json!({"userAgent":42}), json!({"userAgent":"invalid"}),
        json!({"userAgent":"origin/"}), json!({"userAgent":"origin/1.2.3\nextra"}),
        json!({"userAgent":format!("origin/{}", "v".repeat(257))}),
        json!({"supportsSubagentManagement":"true"}), json!({"supportsExpectedTurnInterrupt":null})] {
        let mut invalid = control.clone(); invalid.capabilities = super::super::runtime::observed_capabilities(&response);
        assert!(invalid.observed_capabilities(&exe).is_err(), "{response}");
    }
    assert!(control.observed_capabilities(&OsString::from("different.exe")).unwrap().is_none());
    stopped.store(true, Ordering::Release);
    assert!(control.observed_capabilities(&exe).unwrap().is_none());
    stopped.store(false, Ordering::Release);
    fs::write(&socket, b"replacement with different metadata").unwrap();
    // 변경 시각 정밀도가 낮아도 명시적으로 다른 stamp를 주입해 재사용 차단을 검사한다.
    let mut replaced = control.clone(); replaced.endpoint.stamp.modified = Some(SystemTime::UNIX_EPOCH);
    assert!(replaced.observed_capabilities(&exe).unwrap().is_none());
    fs::remove_file(&socket).unwrap(); fs::remove_dir(&directory).unwrap();
}
