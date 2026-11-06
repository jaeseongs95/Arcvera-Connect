use super::*;
use std::sync::{mpsc, TryLockError, Weak};

#[test]
fn preparing_dsr_output_waits_for_live_input_without_allowing_preparing_user_input() {
    let backend = Arc::new(Mutex::new(None::<Weak<EngineInner>>));
    let controlled_replies = Arc::new(Mutex::new(Vec::new()));
    let native_reply_errors = Arc::new(Mutex::new(Vec::new()));
    let query_tail = Arc::new(Mutex::new(String::new()));
    let ready = Arc::new(AtomicBool::new(false));
    let (replied, reply) = mpsc::channel();
    let (sink_backend, sink_replies, sink_tail, sink_ready) = (backend.clone(), controlled_replies.clone(), query_tail.clone(), ready.clone());
    let sink_native_errors = native_reply_errors.clone();
    let engine = Engine::new(Path::new(":memory:"), Arc::new(move |event| {
        if let BackendEvent::Output(chunk) = event {
            let inner = sink_backend.lock().unwrap().as_ref().and_then(Weak::upgrade).ok_or("fixture backend was dropped")?;
            let engine = Engine { inner };
            engine.acknowledge(&chunk.id, chunk.generation, chunk.seq)?;
            let controlled = chunk.data.contains("controlled-preparing-dsr");
            let queries = if controlled { 1 } else {
                let mut tail = sink_tail.lock().unwrap();
                let previous_bytes = tail.len();
                let scan = tail.clone() + &chunk.data;
                if scan.contains("NATIVE_STARTUP_READY") { sink_ready.store(true, Ordering::Release); }
                *tail = scan.chars().rev().take("NATIVE_STARTUP_READY".len() - 1).collect::<Vec<_>>().into_iter().rev().collect();
                scan.match_indices("\x1b[6n").filter(|(offset, _)| *offset + 4 > previous_bytes).count()
            };
            for _ in 0..queries {
                let phase = engine.lookup(&chunk.id, chunk.generation)?.phase.load(Ordering::Acquire);
                let result = engine.write(&chunk.id, chunk.generation, "\x1b[1;1R");
                if controlled {
                    sink_replies.lock().unwrap().push((phase, result));
                    let _ = replied.send(());
                } else if let Err(error) = result { sink_native_errors.lock().unwrap().push(error); }
            }
        }
        Ok(())
    })).unwrap();
    *backend.lock().unwrap() = Some(Arc::downgrade(&engine.inner));
    let probe_backend = backend.clone();
    *engine.inner.post_install_launch_probe.lock().unwrap() = Some(Arc::new(move |session, _| {
        let inner = probe_backend.lock().unwrap().as_ref().and_then(Weak::upgrade).ok_or("fixture backend was dropped")?;
        let info = session.info()?;
        assert_eq!(session.phase.load(Ordering::Acquire), 0);
        assert_eq!(Engine { inner }.write(&info.id, info.generation, "user input").unwrap_err(), "session is not live");
        Ok(())
    }));
    let producer = Arc::new(Mutex::new(None));
    let probe_producer = producer.clone();
    let reply = Arc::new(Mutex::new(reply));
    let (produced, production) = mpsc::channel();
    *engine.inner.pre_reader_output_probe.lock().unwrap() = Some(Arc::new(move |session| {
        assert_eq!(session.phase.load(Ordering::Acquire), 0);
        let delivery_is_blocked = match session.info.try_lock() {
            Ok(info) => { drop(info); false }
            Err(TryLockError::WouldBlock) => true,
            Err(TryLockError::Poisoned(_)) => return Err("fixture metadata lock poisoned".into()),
        };
        // Inject only the protocol bytes at the production output boundary;
        // the native PTY, Engine input admission and writer remain real.
        let query = "\x1b[6ncontrolled-preparing-dsr".to_owned() + &".".repeat(1024);
        let query_bytes = query.len();
        let output_session = session.clone();
        let produced = produced.clone();
        *probe_producer.lock().unwrap() = Some(thread::spawn(move || {
            let result = output_session.output(query);
            let _ = produced.send(result);
        }));
        if delivery_is_blocked {
            let deadline = Instant::now() + Duration::from_secs(5);
            while session.flow.pending_bytes() < query_bytes {
                if Instant::now() >= deadline { return Err("controlled DSR did not enter production output".into()); }
                thread::yield_now();
            }
        } else {
            // On the original implementation, hold activation until the
            // phase-0 response is observed: RED cannot win by scheduling.
            reply.lock().unwrap().recv_timeout(Duration::from_secs(5)).map_err(|_| "controlled DSR reply was not observed")?;
        }
        Ok(())
    }));
    let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = CommandBuilder::new(shell);
    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('NATIVE_STARTUP_READY'); Start-Sleep -Seconds 30"]);
    let info = engine.start_fixture(StartRequest { cwd: std::env::current_dir().unwrap().to_string_lossy().into_owned(), title: "controlled startup DSR".into(), project_id: None, project_assigned: false, thread_id: None, cols: 80, rows: 24 }, command).unwrap();
    struct Cleanup(Engine, SessionInfo);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = self.0.stop(&self.1.id, self.1.generation); } }
    let cleanup = Cleanup(engine.clone(), info.clone());
    assert!(production.recv_timeout(Duration::from_secs(5)).unwrap().unwrap());
    producer.lock().unwrap().take().unwrap().join().unwrap();
    let replies = controlled_replies.lock().unwrap();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].0, 1, "DSR reached renderer before input activation: {replies:?}");
    assert!(replies[0].1.is_ok(), "DSR reply was lost: {replies:?}");
    drop(replies);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline, "native PTY script did not run after controlled DSR reply");
        thread::yield_now();
    }
    let native_errors = native_reply_errors.lock().unwrap();
    assert!(native_errors.is_empty(), "native DSR replies failed: {native_errors:?}");
    drop(native_errors);
    engine.stop(&info.id, info.generation).unwrap();
    assert_eq!(engine.lookup(&info.id, info.generation).unwrap().phase.load(Ordering::Acquire), 3);
    drop(cleanup);
}
