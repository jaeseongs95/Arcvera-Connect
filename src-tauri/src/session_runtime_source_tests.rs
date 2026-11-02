use super::*;
use std::{fs, process::Command, sync::mpsc};
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

// engineering-test-plan / F2-START-STOP:
// Engine.start -> saved launcher -> real command runner is the smallest boundary
// that distinguishes session cancellation from application-exit cancellation.
// The fixture replaces only the launcher: no real CLI/server/model is invoked.
// Oracle: an in-flight query's original process handle becomes signaled, and
// start/stop both return within 5 seconds of stop (the query waits 30 seconds).
// Target mutation: start's runtime_snapshot_cancelled(&session.stop_requested)
// becomes runtime_snapshot(). Cleanup's exiting flag is set AFTER observations,
// so it cannot make that mutation pass. Native CI/red-green status: NOT_RUN.

fn compile_waiting_launcher(root: &Path) -> Result<PathBuf, String> {
    let source = root.join("launcher.cs");
    fs::write(&source, r#"using System;
using System.IO;
using System.Threading;
class Fixture {
 static int Main(string[] args) {
  if (args.Length != 1 || args[0] != "--opendiy-resolve-json") return 23;
  string root = AppDomain.CurrentDomain.BaseDirectory;
  string pending = Path.Combine(root, "query.pid.pending");
  File.WriteAllText(pending, System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
  File.Move(pending, Path.Combine(root, "query.pid"));
  Thread.Sleep(30000);
  return 24;
 }
}
"#).map_err(|error| format!("write launcher fixture: {error}"))?;
    // The exact stable-launcher basename selects the production resolver path.
    let executable = root.join("opendiy-codex-launcher.exe");
    let compiler = PathBuf::from(std::env::var_os("SystemRoot").ok_or("SystemRoot is missing")?)
        .join("Microsoft.NET/Framework64/v4.0.30319/csc.exe");
    let output = Command::new(compiler).arg("/nologo")
        .arg(format!("/out:{}", executable.display())).arg(&source)
        .creation_flags(0x08000000).output()
        .map_err(|error| format!("compile launcher fixture: {error}"))?;
    if !output.status.success() {
        return Err(format!("launcher fixture compiler {}: {} {}", output.status,
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)));
    }
    Ok(executable)
}

fn observe_start_stop(root: &Path, executable: &Path) -> Result<(), String> {
    let (allocated, allocation) = mpsc::channel();
    let engine = Engine::new(Path::new(":memory:"), Arc::new(move |event| {
        if let BackendEvent::Changed(info) = event {
            if info.state == "starting" { allocated.send(info).map_err(|error| error.to_string())?; }
        }
        Ok(())
    }))?;
    engine.inner.store.lock().map_err(|_| "fixture store lock poisoned")?
        .set_codex_executable(Some(executable.to_str().ok_or("fixture path is not UTF-8")?))?;
    let request = StartRequest {
        cwd: root.to_string_lossy().into_owned(), title: "런처 조회 중 세션 중단 시험".into(),
        project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24,
    };
    let starting = engine.clone();
    let start_worker = thread::Builder::new().name("launcher-stop-start".into())
        .spawn(move || starting.start(request)).map_err(|error| format!("spawn start worker: {error}"))?;
    let mut stop_worker = None;
    let mut original = None;
    // No assertions or early returns from this function until all workers have
    // been joined. In particular, a beacon/setup failure still cancels start.
    let observation = (|| -> Result<SessionInfo, String> {
        let info = allocation.recv_timeout(Duration::from_secs(8))
            .map_err(|error| format!("Engine.start allocation was not observed: {error}"))?;
        let deadline = Instant::now() + Duration::from_secs(8);
        let beacon = root.join("query.pid");
        while !beacon.exists() {
            if start_worker.is_finished() { return Err("start returned before entering launcher query".into()); }
            if Instant::now() >= deadline { return Err("launcher query PID beacon timed out".into()); }
            thread::sleep(Duration::from_millis(2));
        }
        // File.Move publishes only a fully written and closed PID file.
        let pid = fs::read_to_string(beacon).map_err(|error| error.to_string())?
            .parse::<u32>().map_err(|error| error.to_string())?;
        let handle = unsafe { OpenProcess(0x00100000, 0, pid) }; // SYNCHRONIZE only
        if handle.is_null() { return Err(format!("open original query process: {}", std::io::Error::last_os_error())); }
        original = Some(unsafe { OwnedHandle::from_raw_handle(handle.cast()) });
        if start_worker.is_finished() || unsafe { WaitForSingleObject(handle, 0) } != 258 {
            return Err("launcher query was not in flight before stop".into());
        }
        let stopping = engine.clone();
        let id = info.id.clone();
        let generation = info.generation;
        // Record all three observations before fallback cancellation can act.
        let deadline = Instant::now() + Duration::from_secs(5);
        stop_worker = Some(thread::Builder::new().name("launcher-stop-stop".into())
            .spawn(move || stopping.stop(&id, generation)).map_err(|error| format!("spawn stop worker: {error}"))?);
        loop {
            let start_done = start_worker.is_finished();
            let stop_done = stop_worker.as_ref().is_some_and(|worker| worker.is_finished());
            let query_terminated = unsafe { WaitForSingleObject(handle, 0) } == 0;
            if Instant::now() >= deadline {
                return Err(format!("stop did not cancel in-flight launcher within 5 seconds: start_returned={start_done}, stop_returned={stop_done}, original_query_terminated={query_terminated}"));
            }
            if start_done && stop_done && query_terminated { return Ok(info); }
            thread::sleep(Duration::from_millis(2));
        }
    })();

    // With the target mutation, session.stop_requested is not the query's
    // cancellation source. Exiting is the independent fallback for safe cleanup.
    engine.inner.exiting.store(true, Ordering::Release);
    if let Ok(sessions) = engine.inner.sessions.lock() {
        for session in sessions.values() { session.stop_requested.store(true, Ordering::Release); }
    }
    let start_result = start_worker.join();
    let stop_result = stop_worker.map(|worker| worker.join());
    let original_terminated = original.as_ref().map(|handle| unsafe {
        WaitForSingleObject(handle.as_raw_handle().cast(), 1000)
    });
    let info = observation?;
    if original_terminated != Some(0) { return Err(format!("original query survived worker cleanup: {original_terminated:?}")); }
    let started = start_result.map_err(|_| "Engine.start worker panicked")?;
    if !matches!(started, Err(ref error) if error.contains("cancelled")) {
        return Err(format!("Engine.start must return cancellation: {started:?}"));
    }
    stop_result.ok_or("Engine.stop was not called")?.map_err(|_| "Engine.stop worker panicked")??;
    let session = engine.lookup(&info.id, info.generation)?;
    let finished = session.info()?;
    if finished.active || finished.state != "stopped" || session.process.lock().map_err(|_| "fixture process lock poisoned")?.is_some() {
        return Err(format!("cancelled launcher left an active session/process: {finished:?}"));
    }
    Ok(())
}

fn remove_launcher_fixture(root: &Path) -> Result<(), String> {
    // No recursive deletion: only this invocation's fixed fixture files, under
    // its UUID-named direct child of the verified temporary directory.
    let temp = std::env::temp_dir().canonicalize().map_err(|error| error.to_string())?;
    let actual = root.canonicalize().map_err(|error| error.to_string())?;
    if actual.parent() != Some(temp.as_path()) || actual.file_name() != root.file_name() {
        return Err("refused fixture cleanup outside its original temporary directory".into());
    }
    for name in ["launcher.cs", "opendiy-codex-launcher.exe", "query.pid.pending", "query.pid"] {
        let path = actual.join(name);
        match fs::remove_file(path) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("remove fixture {name}: {error}")),
        }
    }
    fs::remove_dir(actual).map_err(|error| format!("remove fixture directory: {error}"))
}

#[test]
fn stop_cancels_engine_start_during_launcher_query_and_reaps_the_original_child() {
    let _serial = lifecycle_tests::EXTENSION_ADMISSION_TEST.lock().unwrap_or_else(|error| error.into_inner());
    let root = std::env::temp_dir().join(format!("opendiy-runtime-source-stop-{}", Uuid::new_v4()));
    fs::create_dir(&root).unwrap();
    let result = compile_waiting_launcher(&root).and_then(|executable| observe_start_stop(&root, &executable));
    let cleanup = remove_launcher_fixture(&root);
    assert!(result.is_ok() && cleanup.is_ok(), "F2-START-STOP: {result:?}; fixture cleanup: {cleanup:?}");
}
