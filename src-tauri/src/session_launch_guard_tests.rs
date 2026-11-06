use super::*;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::{
    Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS},
    System::{JobObjects::{QueryInformationJobObject, JobObjectBasicAccountingInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION},
        Threading::{GetCurrentProcess, OpenProcess, WaitForSingleObject}},
};

#[derive(Clone, Debug)]
struct LaunchCompletionObservation { state: String, active: bool, process_slot_empty: bool, original_child_signaled: bool }

#[test]
fn launch_post_install_failure_publishes_unknown_once_after_owned_cleanup() {
    const INJECTED: &str = "fixture post-install launch failure";
    let observations = Arc::new(Mutex::new(Vec::<LaunchCompletionObservation>::new()));
    let observed_session = Arc::new(Mutex::new(None::<std::sync::Weak<Session>>));
    let original = Arc::new(Mutex::new(None::<(u32, OwnedHandle)>));
    let (sink_observations, sink_session, sink_original) = (observations.clone(), observed_session.clone(), original.clone());
    let sink = Arc::new(move |event| {
        if let BackendEvent::Changed(info) = event {
            if matches!(info.state.as_str(), "stopped" | "error" | "unknown") {
                // The delivery callback only records. Assertions/panics here
                // would alter the failure path whose ordering we are testing.
                let session = sink_session.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(std::sync::Weak::upgrade);
                let process_slot_empty = session.as_ref().is_some_and(|session| session.process.lock().unwrap_or_else(|e| e.into_inner()).is_none());
                let original_child_signaled = sink_original.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                    .is_some_and(|(_, handle)| unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) } == 0);
                sink_observations.lock().unwrap_or_else(|e| e.into_inner()).push(LaunchCompletionObservation {
                    state: info.state, active: info.active, process_slot_empty, original_child_signaled,
                });
            }
        }
        Ok(())
    });
    let engine = Engine::new(Path::new(":memory:"), sink).unwrap();
    let request = StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: "설치 후 시작 실패 순서 시험".into(), project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24 };
    let session = engine.allocate(&request).unwrap();
    *observed_session.lock().unwrap() = Some(Arc::downgrade(&session));
    let probe_original = original.clone();
    *engine.inner.post_install_launch_probe.lock().unwrap() = Some(Arc::new(move |session, child| {
        let pid = child.process_id().ok_or("fixture child has no PID")?;
        let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
        if handle.is_null() { return Err(format!("open fixture child handle: {}", std::io::Error::last_os_error())); }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
        *probe_original.lock().map_err(|_| "fixture child handle lock poisoned")? = Some((pid, handle));
        let process = session.process.lock().map_err(|_| "fixture process slot lock poisoned")?.clone().ok_or("fixture process slot was not installed")?;
        process.shared_cleanup_failed.store(true, Ordering::Release);
        process.shared_stop_attempted.store(true, Ordering::Release);
        session.request_stop()?;
        Err(INJECTED.into())
    }));
    let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = CommandBuilder::new(shell);
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
    let launching_engine = engine.clone();
    let launching_session = session.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        let result = launching_engine.launch(launching_session, command, None, 80, 24);
        let _ = send.send(result);
    });
    // Keep the real launch closure's not-yet-started reader state. In
    // particular, do not add a test-only drainer to hide ConPTY close failures.
    let result = receive.recv_timeout(Duration::from_secs(15)).expect("실제 launch 실패 정리가 반환되지 않았습니다. ConPTY/reader 정체를 확인하세요.");
    worker.join().unwrap();
    assert_eq!(result.unwrap_err(), INJECTED);
    let observations = observations.lock().unwrap().clone();
    assert_eq!(observations.len(), 1, "완료가 정리 전 또는 두 번 발표됐습니다: {observations:?}");
    assert_eq!(observations[0].state, "unknown");
    assert!(!observations[0].active);
    assert!(observations[0].process_slot_empty, "완료 발표 시 소유 프로세스 slot이 남았습니다.");
    assert!(observations[0].original_child_signaled, "완료 발표 시 원래 소유 자식이 종료되지 않았습니다.");
    assert!(session.process.lock().unwrap().is_none());
    assert!(*session.done.0.lock().unwrap());
    assert!(session.cleanup_failed.load(Ordering::Acquire));
    let info = session.info().unwrap();
    assert_eq!(info.state, "unknown");
    assert!(!info.active);
    assert!(engine.stop(&info.id, info.generation).unwrap_err().contains("재전송하지 않았습니다"));
    println!("실제 launch 실패 완료 순서: ownedPid={}, completionCount=1, state=unknown, processSlotEmpty=true, originalChildSignaled=true", original.lock().unwrap().as_ref().unwrap().0);
}

struct WorkerFailureIdentity { pid: u32, child: OwnedHandle, job: OwnedHandle }
fn worker_failure_job_active(job: &OwnedHandle) -> Option<u32> {
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    let queried = unsafe { QueryInformationJobObject(job.as_raw_handle(), JobObjectBasicAccountingInformation,
        &mut info as *mut _ as _, std::mem::size_of_val(&info) as u32, std::ptr::null_mut()) };
    (queried != 0).then_some(info.ActiveProcesses)
}

#[test]
fn launch_output_worker_install_failure_reaps_owned_child_and_drops_reader_capture() {
    worker_install_failure_case("pty-output", 0);
}

#[test]
fn launch_reaper_worker_install_failure_reaps_owned_child_and_joins_live_reader() {
    worker_install_failure_case("pty-reaper", 1);
}

fn worker_install_failure_case(name: &'static str, expected_readers: usize) {
    let observations = Arc::new(Mutex::new(Vec::<(LaunchCompletionObservation, Option<u32>, usize)>::new()));
    let observed_session = Arc::new(Mutex::new(None::<std::sync::Weak<Session>>));
    let original = Arc::new(Mutex::new(None::<WorkerFailureIdentity>));
    let (sink_observations, sink_session, sink_original) = (observations.clone(), observed_session.clone(), original.clone());
    let sink = Arc::new(move |event| {
        if let BackendEvent::Changed(info) = event {
            if matches!(info.state.as_str(), "stopped" | "error" | "unknown") {
                let session = sink_session.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(std::sync::Weak::upgrade);
                let process_slot_empty = session.as_ref().is_some_and(|session| session.process.lock().unwrap_or_else(|e| e.into_inner()).is_none());
                let identity = sink_original.lock().unwrap_or_else(|e| e.into_inner());
                let original_child_signaled = identity.as_ref().is_some_and(|identity| unsafe { WaitForSingleObject(identity.child.as_raw_handle(), 0) } == 0);
                let job_active = identity.as_ref().and_then(|identity| worker_failure_job_active(&identity.job));
                let finished_readers = crate::owned_worker::snapshot().finished;
                sink_observations.lock().unwrap_or_else(|e| e.into_inner()).push((LaunchCompletionObservation {
                    state: info.state, active: info.active, process_slot_empty, original_child_signaled,
                }, job_active, finished_readers));
            }
        }
        Ok(())
    });
    let engine = Engine::new(Path::new(":memory:"), sink).unwrap();
    let request = StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: format!("{name} 설치 실패 시험"), project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24 };
    let session = engine.allocate(&request).unwrap();
    *observed_session.lock().unwrap() = Some(Arc::downgrade(&session));
    let probe_original = original.clone();
    *engine.inner.post_install_launch_probe.lock().unwrap() = Some(Arc::new(move |session, child| {
        let pid = child.process_id().ok_or("fixture child has no PID")?;
        let raw = unsafe { OpenProcess(0x00100000, 0, pid) };
        if raw.is_null() { return Err(format!("open worker fixture child: {}", std::io::Error::last_os_error())); }
        let child = unsafe { OwnedHandle::from_raw_handle(raw) };
        let process = session.process.lock().map_err(|_| "fixture process slot lock poisoned")?.clone().ok_or("fixture process was not installed")?;
        let job = process.job.lock().map_err(|_| "fixture Job lock poisoned")?;
        let job = job.as_ref().ok_or("fixture Job was not installed")?;
        let mut copied = std::ptr::null_mut();
        if unsafe { DuplicateHandle(GetCurrentProcess(), job.as_handle().as_raw_handle(), GetCurrentProcess(), &mut copied, 0, 0, DUPLICATE_SAME_ACCESS) } == 0 {
            return Err(format!("duplicate worker fixture Job: {}", std::io::Error::last_os_error()));
        }
        let job = unsafe { OwnedHandle::from_raw_handle(copied) };
        *probe_original.lock().map_err(|_| "fixture identity lock poisoned")? = Some(WorkerFailureIdentity { pid, child, job });
        // Observe ownership only. The failure must occur at the real worker
        // spawn branch after this probe has returned successfully.
        Ok(())
    }));
    let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = CommandBuilder::new(shell);
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
    let session_owners_before_launch = Arc::strong_count(&session);
    let launching_engine = engine.clone();
    let launching_session = session.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || {
        let observed = crate::owned_worker::fail_once(name, || {
            let result = launching_engine.launch(launching_session, command, None, 80, 24);
            (result, crate::owned_worker::snapshot(), OWNED_CHILD_DROP_METADATA.with(|observations| observations.borrow().clone()))
        });
        let _ = send.send(observed);
    });
    let (result, trace, child_drops) = receive.recv_timeout(Duration::from_secs(15)).expect("실제 worker 설치 실패 정리가 반환되지 않았습니다. reader/ConPTY 정체를 확인하세요.");
    worker.join().unwrap();
    assert!(result.unwrap_err().contains(if name == "pty-output" { "start PTY reader:" } else { "start PTY reaper:" }));
    assert_eq!(trace.failed, 1);
    assert_eq!(trace.spawned, expected_readers);
    assert_eq!(trace.started, expected_readers);
    assert_eq!(trace.started_at_failure, expected_readers);
    assert_eq!(trace.finished_at_failure, 0, "reaper 실패 전에 첫 reader가 살아 있어야 합니다.");
    assert_eq!(trace.finished, expected_readers, "실패 task capture 또는 이미 실행한 reader가 회수되지 않았습니다.");
    let observations = observations.lock().unwrap().clone();
    assert_eq!(observations.len(), 1, "worker 설치 실패 완료가 중복됐습니다: {observations:?}");
    let (completion, job_active, finished_at_completion) = &observations[0];
    assert_eq!(completion.state, "error");
    assert!(!completion.active);
    assert!(completion.process_slot_empty);
    assert!(completion.original_child_signaled);
    assert_eq!(*job_active, Some(0));
    assert_eq!(*finished_at_completion, expected_readers, "reader 회수 전에 완료를 발표했습니다.");
    assert_eq!(Arc::strong_count(&session), session_owners_before_launch, "실패 worker task capture가 세션 소유권을 남겼습니다.");
    assert!(session.process.lock().unwrap().is_none());
    assert!(*session.done.0.lock().unwrap());
    let identity = original.lock().unwrap();
    let identity = identity.as_ref().unwrap();
    assert_eq!(child_drops, [(Some(identity.pid), true)], "child drop/wait held metadata or did not observe the original child: {child_drops:?}");
    assert_eq!(unsafe { WaitForSingleObject(identity.child.as_raw_handle(), 0) }, 0);
    assert_eq!(worker_failure_job_active(&identity.job), Some(0));
    println!("실제 worker 설치 실패: name={name}, ownedPid={}, failed=1, startedReaders={expected_readers}, finishedReaders={expected_readers}, completionCount=1, processSlotEmpty=true, originalChildSignaled=true, jobActive=0, childDropMetadataAvailable=true", identity.pid);
}

#[test]
fn failed_launch_guard_preserves_unknown_shared_stop_and_reaps_owned_pty() {
    for resume_before_stop in [false, true] { failed_launch_guard_case(resume_before_stop); }
}

fn failed_launch_guard_case(resume_before_stop: bool) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let sink = Arc::new(move |event| {
        if let BackendEvent::Changed(info) = event { sink_events.lock().unwrap().push(info.state); }
        Ok(())
    });
    let engine = Engine::new(Path::new(":memory:"), sink).unwrap();
    let request = StartRequest {cwd:std::env::current_dir().unwrap().to_string_lossy().into_owned(),title:"시작 정리 시험".into(),project_id:None,project_assigned:false,thread_id:None,cols:80,rows:24};
    let session = engine.allocate(&request).unwrap();
    // process 설치 뒤 launch가 실패한 경계만 직접 구성한다. 정규 reaper가 아직
    // 없는 단계이므로 LaunchGuard가 정리 결과와 최종 상태를 모두 인계해야 한다.
    let pair = native_pty_system().openpty(size(80, 24)).unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let drainer = thread::spawn(move || { let _ = std::io::copy(&mut reader, &mut std::io::sink()); });
    let writer = pair.master.take_writer().unwrap();
    let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = CommandBuilder::new(shell);
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
    let job = ProcessJob::new(false).unwrap();
    let suspended = pair.slave.spawn_command_in_job_suspended(command, job.as_handle()).unwrap();
    let (pty_child, resume) = suspended.into_parts();
    let mut resume = Some(resume);
    let mut child = OwnedChild {child:pty_child,reaped:false,metadata:Arc::downgrade(&session)};
    drop(pair.slave);
    let owned_pid = child.child.process_id().unwrap();
    let handle = unsafe { OpenProcess(0x00100000, 0, owned_pid) };
    assert!(!handle.is_null());
    let original = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };
    let process = Arc::new(ProcessControl {master:Mutex::new(Some(pair.master)),writer:Mutex::new(Some(writer)),reader:Mutex::new(None),killer:Mutex::new(child.child.clone_killer()),job:Mutex::new(Some(job)),adapter:Mutex::new(None),
        #[cfg(windows)] cron:Mutex::new(None),
        termination:Mutex::new(()),shared_cleanup_failed:AtomicBool::new(true),shared_stop_attempted:AtomicBool::new(true)});
    // 공유 RPC가 불명 결과를 기록한 인계 플래그만 주입한다. 이후 adapter가 이미
    // 회수되었더라도 추가 owned 정리가 그 불명을 성공으로 바꾸면 안 된다.
    *session.process.lock().unwrap() = Some(process.clone());
    if resume_before_stop { resume.take().unwrap().resume().unwrap(); }
    session.request_stop().unwrap();
    drop(LaunchGuard {session:session.clone(),armed:true,reaper:None});
    // Cancellation before commit and failure after commit must both reap the
    // same direct PTY. The retained token cannot revive a stopped generation.
    drop(resume);
    assert_eq!(unsafe { WaitForSingleObject(original.as_raw_handle().cast(), 1000) }, 0, "원래 소유 PTY는 실패 정리 반환 전에 종료되어야 한다");
    child.wait().unwrap();
    drainer.join().unwrap();
    let info = session.info().unwrap();
    assert_eq!(info.state, "unknown", "공유 중단 불명을 inactive/stopped로 바꾸면 안 된다");
    assert!(!info.active);
    assert!(session.cleanup_failed.load(Ordering::Acquire));
    assert!(session.process.lock().unwrap().is_none());
    assert!(*session.done.0.lock().unwrap());
    assert!(!events.lock().unwrap().iter().any(|state| state == "stopped"));
    assert!(engine.stop(&info.id, info.generation).unwrap_err().contains("재전송하지 않았습니다"));
    println!("시작 실패 guard: resumeBeforeStop={resume_before_stop}, ownedPid={owned_pid}, state=unknown, active=false, done=true, stoppedNotPublished=true");
}

#[test]
fn launch_activation_sink_failure_waits_for_reader_and_publishes_once() {
    for expected in ["error", "stopped", "unknown"] { activation_sink_failure_case(expected); }
}

fn activation_sink_failure_case(expected: &'static str) {
    const INJECTED: &str = "fixture activation sink failure";
    const MARKER: &str = "LAUNCH_READER_GATE";
    let observed = Arc::new(Mutex::new(None::<std::sync::Weak<Session>>));
    let completions = Arc::new(Mutex::new(Vec::<LaunchCompletionObservation>::new()));
    let original = Arc::new(Mutex::new(None::<WorkerFailureIdentity>));
    let backend = Arc::new(Mutex::new(None::<std::sync::Weak<EngineInner>>));
    let dsr_replies = Arc::new(Mutex::new(Vec::new()));
    let (sink_backend, sink_dsr_replies) = (backend.clone(), dsr_replies.clone());
    let query_tail = Mutex::new(String::new());
    let (entered, entry) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (failed, failure) = std::sync::mpsc::channel();
    let (completed, completion) = std::sync::mpsc::channel();
    let (entry, released) = (Mutex::new(entry), Mutex::new(released));
    let (activation_seen, reader_seen) = (AtomicBool::new(false), AtomicBool::new(false));
    let tail = Mutex::new(String::new());
    let (sink_session, sink_completions, sink_original) = (observed.clone(), completions.clone(), original.clone());
    let engine = Engine::new(Path::new(":memory:"), Arc::new(move |event| {
        let session = sink_session.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade);
        match event {
            BackendEvent::Output(chunk) => {
                let session = session.ok_or("fixture session missing at reader output")?;
                session.flow.acknowledge(chunk.seq)?;
                reply_launch_fixture_dsr(&sink_backend, &query_tail, &sink_dsr_replies, &chunk)?;
                let marker = {
                    let mut tail = tail.lock().unwrap();
                    tail.push_str(&chunk.data);
                    let found = tail.contains(MARKER);
                    *tail = tail.chars().rev().take(MARKER.len()).collect::<Vec<_>>().into_iter().rev().collect();
                    found
                };
                if marker && !reader_seen.swap(true, Ordering::AcqRel) {
                    let _ = entered.send(());
                    released.lock().unwrap().recv_timeout(Duration::from_secs(10)).map_err(|_| "fixture reader release deadline")?;
                }
            }
            BackendEvent::Changed(info) if !info.active => {
                let session = session.ok_or("fixture session missing at completion")?;
                let identity = sink_original.lock().unwrap();
                let original_child_signaled = identity.as_ref().is_some_and(|identity| unsafe { WaitForSingleObject(identity.child.as_raw_handle(), 0) } == 0);
                sink_completions.lock().unwrap().push(LaunchCompletionObservation {
                    state: info.state, active: info.active,
                    process_slot_empty: session.process.lock().unwrap().is_none(), original_child_signaled,
                });
                let _ = completed.send(());
            }
            BackendEvent::Changed(info) if info.state == "unknown" && !activation_seen.swap(true, Ordering::AcqRel) => {
                entry.lock().unwrap().recv_timeout(Duration::from_secs(8)).map_err(|_| "fixture reader did not enter actual output sink")?;
                if expected != "error" { session.ok_or("fixture session missing at stop")?.request_stop()?; }
                let _ = failed.send(());
                return Err(INJECTED.into());
            }
            _ => {},
        }
        Ok(())
    })).unwrap();
    *backend.lock().unwrap() = Some(Arc::downgrade(&engine.inner));
    let request = StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: "activation 실패 reader 완료 순서".into(), project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24 };
    let session = engine.allocate(&request).unwrap();
    *observed.lock().unwrap() = Some(Arc::downgrade(&session));
    let probe_original = original.clone();
    *engine.inner.post_install_launch_probe.lock().unwrap() = Some(Arc::new(move |session, child| {
        *probe_original.lock().unwrap() = Some(launch_identity(session, child)?);
        if expected == "unknown" {
            let process = session.process.lock().unwrap().clone().unwrap();
            process.shared_cleanup_failed.store(true, Ordering::Release);
            process.shared_stop_attempted.store(true, Ordering::Release);
        }
        Ok(())
    }));
    let mut command = launch_shell();
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('LAUNCH_READER_GATE'); Start-Sleep -Seconds 30"]);
    let launching_session = session.clone();
    let (returned, result) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || { let _ = returned.send(engine.launch(launching_session, command, None, 80, 24)); });
    let activation_failed = failure.recv_timeout(Duration::from_secs(10));
    let early_completion = completion.recv_timeout(Duration::from_millis(500));
    let early_phase = session.phase.load(Ordering::Acquire);
    let early_done = *session.done.0.lock().unwrap();
    // Always release the real reader before asserting, including on RED.
    let _ = release.send(());
    let result = result.recv_timeout(Duration::from_secs(15)).expect("activation 실패 정리가 reader 해제 뒤 반환되지 않았습니다");
    worker.join().unwrap();
    assert!(activation_failed.is_ok(), "실제 activation sink 실패에 도달하지 못했습니다: dsrReplies={:?}, launchResult={result:?}", dsr_replies.lock().unwrap());
    assert!(dsr_replies.lock().unwrap().iter().all(Result::is_ok), "fixture DSR 응답이 실패했습니다");
    assert_eq!(result.unwrap_err(), INJECTED);
    assert!(early_completion.is_err(), "reader 완료 전에 terminal 이벤트가 발표됐습니다");
    assert!(early_phase < 3, "reader 완료 전에 phase3이 발표됐습니다");
    assert!(!early_done, "reader 완료 전에 done이 발표됐습니다");
    let completions = completions.lock().unwrap();
    assert_eq!(completions.len(), 1, "activation 실패 완료 중복: {completions:?}");
    assert_eq!(completions[0].state, expected);
    assert!(!completions[0].active);
    assert!(completions[0].process_slot_empty);
    assert!(completions[0].original_child_signaled);
    assert!(session.process.lock().unwrap().is_none());
    assert!(*session.done.0.lock().unwrap());
    assert_eq!(session.info().unwrap().state, expected);
    let identity = original.lock().unwrap();
    assert_eq!(worker_failure_job_active(&identity.as_ref().unwrap().job), Some(0));
    println!("activation sink 실패: expected={expected}, completionCount=1, readerBeforeDone=true, childSignaled=true, jobActive=0");
}

fn launch_shell() -> CommandBuilder {
    CommandBuilder::new(PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe"))
}

fn reply_launch_fixture_dsr(backend: &Mutex<Option<std::sync::Weak<EngineInner>>>, tail: &Mutex<String>, replies: &Mutex<Vec<Result<(), String>>>, chunk: &TerminalOutput) -> Result<(), String> {
    // ConPTY inherits the renderer cursor. As in startup_output_tests, this
    // headless renderer must answer DSR before PowerShell can reach its script.
    let queries = {
        let mut tail = tail.lock().unwrap();
        let previous_bytes = tail.len();
        let scan = tail.clone() + &chunk.data;
        *tail = scan.chars().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect();
        scan.match_indices("\x1b[6n").filter(|(offset, _)| *offset + 4 > previous_bytes).count()
    };
    for _ in 0..queries {
        let inner = backend.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade).ok_or("fixture backend missing at DSR")?;
        let result = (Engine { inner }).write(&chunk.id, chunk.generation, "\x1b[1;1R");
        println!("launch fixture DSR: session={}, generation={}, reply={result:?}", chunk.id, chunk.generation);
        replies.lock().unwrap().push(result.clone());
        result?;
    }
    Ok(())
}

fn launch_identity(session: &Session, child: &dyn portable_pty::Child) -> Result<WorkerFailureIdentity, String> {
    let pid = child.process_id().ok_or("fixture child has no PID")?;
    let raw = unsafe { OpenProcess(0x00100000, 0, pid) };
    if raw.is_null() { return Err(format!("open launch fixture child: {}", std::io::Error::last_os_error())); }
    let child = unsafe { OwnedHandle::from_raw_handle(raw) };
    let process = session.process.lock().map_err(|_| "fixture process lock poisoned")?.clone().ok_or("fixture process missing")?;
    let job = process.job.lock().map_err(|_| "fixture Job lock poisoned")?;
    let mut copied = std::ptr::null_mut();
    if unsafe { DuplicateHandle(GetCurrentProcess(), job.as_ref().ok_or("fixture Job missing")?.as_handle().as_raw_handle(), GetCurrentProcess(), &mut copied, 0, 0, DUPLICATE_SAME_ACCESS) } == 0 {
        return Err(format!("duplicate launch fixture Job: {}", std::io::Error::last_os_error()));
    }
    Ok(WorkerFailureIdentity { pid, child, job: unsafe { OwnedHandle::from_raw_handle(copied) } })
}

#[test]
fn launch_resume_rejection_and_metadata_failure_complete_after_reaper_cleanup() {
    for fail_save in [false, true] {
        let engine = Engine::new(Path::new(":memory:"), Arc::new(|_| Ok(()))).unwrap();
        let request = StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: "reaper 설치 뒤 실제 시작 오류".into(), project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24 };
        let session = engine.allocate(&request).unwrap();
        let original = Arc::new(Mutex::new(None));
        let probe_original = original.clone();
        *engine.inner.post_install_launch_probe.lock().unwrap() = Some(Arc::new(move |session, child| {
            let identity = launch_identity(session, child)?;
            if !fail_save {
                let process = session.process.lock().unwrap().clone().unwrap();
                process.terminate()?;
                if unsafe { WaitForSingleObject(identity.child.as_raw_handle(), 5000) } != 0 { return Err("fixture child did not exit before actual resume rejection".into()); }
            }
            *probe_original.lock().unwrap() = Some(identity);
            Ok(())
        }));
        if fail_save {
            *engine.inner.pre_reader_output_probe.lock().unwrap() = Some(Arc::new(|session| {
                // Poison only this fixture's Store mutex. The error must arise
                // in the real save path after both workers are installed.
                let store = session.store.clone();
                assert!(thread::spawn(move || { let _store = store.lock().unwrap(); panic!("fixture metadata store poison"); }).join().is_err());
                Ok(())
            }));
        }
        let mut command = launch_shell();
        command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"]);
        let launching_session = session.clone();
        let (returned, result) = std::sync::mpsc::channel();
        let worker = thread::spawn(move || { let _ = returned.send(engine.launch(launching_session, command, None, 80, 24)); });
        let error = result.recv_timeout(Duration::from_secs(15)).expect("reaper 설치 뒤 실패 정리가 반환되지 않았습니다").unwrap_err();
        worker.join().unwrap();
        assert!(error.contains(if fail_save { "metadata store lock poisoned" } else { "resume owned PTY process:" }), "원래 시작 오류가 변경됐습니다: {error}");
        assert!(session.process.lock().unwrap().is_none());
        assert!(*session.done.0.lock().unwrap());
        assert_eq!(session.phase.load(Ordering::Acquire), 3);
        let info = session.info().unwrap();
        assert_eq!(info.state, "error");
        assert!(!info.active);
        let identity = original.lock().unwrap();
        let identity = identity.as_ref().unwrap();
        assert_eq!(unsafe { WaitForSingleObject(identity.child.as_raw_handle(), 0) }, 0);
        assert_eq!(worker_failure_job_active(&identity.job), Some(0));
        println!("reaper 설치 뒤 실제 시작 오류: failSave={fail_save}, ownedPid={}, state=error, done=true, childSignaled=true, jobActive=0", identity.pid);
    }
}

#[test]
fn launch_fast_exit_waits_for_activation_delivery_before_completion() {
    let observed = Arc::new(Mutex::new(None::<std::sync::Weak<Session>>));
    let states = Arc::new(Mutex::new(Vec::new()));
    let backend = Arc::new(Mutex::new(None::<std::sync::Weak<EngineInner>>));
    let dsr_replies = Arc::new(Mutex::new(Vec::new()));
    let (sink_backend, sink_dsr_replies) = (backend.clone(), dsr_replies.clone());
    let query_tail = Mutex::new(String::new());
    let (activation, activated) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let (completed, completion) = std::sync::mpsc::channel();
    let released = Mutex::new(released);
    let (sink_session, sink_states) = (observed.clone(), states.clone());
    let engine = Engine::new(Path::new(":memory:"), Arc::new(move |event| {
        match event {
            BackendEvent::Output(chunk) => {
                if let Some(session) = sink_session.lock().unwrap().as_ref().and_then(std::sync::Weak::upgrade) { session.flow.acknowledge(chunk.seq)?; }
                reply_launch_fixture_dsr(&sink_backend, &query_tail, &sink_dsr_replies, &chunk)?;
            }
            BackendEvent::Changed(info) if !info.active => {
                sink_states.lock().unwrap().push(info.state);
                let _ = completed.send(());
            }
            BackendEvent::Changed(info) if info.state == "unknown" => {
                let _ = activation.send(());
                released.lock().unwrap().recv_timeout(Duration::from_secs(10)).map_err(|_| "fixture activation release deadline")?;
            }
            _ => {},
        }
        Ok(())
    })).unwrap();
    *backend.lock().unwrap() = Some(Arc::downgrade(&engine.inner));
    let session = engine.allocate(&StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: "activation 전달 전 빠른 정상 종료".into(), project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24 }).unwrap();
    *observed.lock().unwrap() = Some(Arc::downgrade(&session));
    let original = Arc::new(Mutex::new(None));
    let probe_original = original.clone();
    *engine.inner.post_install_launch_probe.lock().unwrap() = Some(Arc::new(move |session, child| {
        *probe_original.lock().unwrap() = Some(launch_identity(session, child)?);
        Ok(())
    }));
    let mut command = launch_shell();
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
    let launching_session = session.clone();
    let (returned, result) = std::sync::mpsc::channel();
    let worker = thread::spawn(move || { let _ = returned.send(engine.launch(launching_session, command, None, 80, 24)); });
    let activation_entered = activated.recv_timeout(Duration::from_secs(8));
    let signaled = original.lock().unwrap().as_ref().map(|identity| unsafe { WaitForSingleObject(identity.child.as_raw_handle(), 5000) });
    let early_completion = completion.recv_timeout(Duration::from_millis(500));
    let early_phase = session.phase.load(Ordering::Acquire);
    let early_done = *session.done.0.lock().unwrap();
    let _ = release.send(());
    let result = result.recv_timeout(Duration::from_secs(15)).expect("activation 해제 뒤 launch가 반환되지 않았습니다");
    worker.join().unwrap();
    let completion_observed = if early_completion.is_ok() { true } else { completion.recv_timeout(Duration::from_secs(8)).is_ok() };
    assert!(activation_entered.is_ok());
    assert_eq!(signaled, Some(0), "activation 전달 중 실제 child가 종료해야 합니다: dsrReplies={:?}", dsr_replies.lock().unwrap());
    assert!(dsr_replies.lock().unwrap().iter().all(Result::is_ok), "fixture DSR 응답이 실패했습니다");
    assert!(result.is_ok(), "정상 exit0 launch가 실패했습니다: {result:?}");
    assert!(early_completion.is_err(), "activation 전달 확정 전에 완료를 발표했습니다");
    assert!(early_phase < 3);
    assert!(!early_done);
    assert!(completion_observed);
    // finish sends Changed before notifying done; sink delivery alone is not
    // proof that completion waiters have been notified.
    let done = session.done.0.lock().unwrap();
    let (done, _) = session.done.1.wait_timeout_while(done, Duration::from_secs(5), |done| !*done).unwrap();
    assert!(*done);
    drop(done);
    assert_eq!(*states.lock().unwrap(), ["exited"]);
    assert!(session.process.lock().unwrap().is_none());
    assert!(*session.done.0.lock().unwrap());
    println!("빠른 정상 종료: activationBeforeCompletion=true, completionCount=1, state=exited, done=true");
}
