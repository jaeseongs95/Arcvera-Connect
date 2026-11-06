//! Native suspended launch regression fixtures; production uses owned_process.
#[cfg(all(test, windows))]
mod tests {
    use crate::owned_process::{spawn_suspended, Child as NativeChild, Command as NativeCommand, ResumeToken, Stdio as NativeStdio};
    use crate::process_job::ProcessJob;
    use std::{
        ffi::OsString,
        io::{BufRead, BufReader, Read, Write},
        os::windows::{ffi::{OsStrExt, OsStringExt}, io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle}},
        process::ExitStatus,
        sync::{mpsc::{self, Receiver}, Arc, Mutex},
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{FILETIME, INVALID_HANDLE_VALUE},
        System::{Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            JobObjects::IsProcessInJob, Threading::{CreateEventW, GetCurrentProcess, GetProcessTimes}},
    };

    const FIXTURE: &str = "launch_gate::tests::environment_fixture_child";
    const REPORT: &str = "opendiy-launch-environment:";
    const KEYS: [&str; 2] = ["APP_CACHE_WIRE_DIAGNOSTICS", "CODEX_HOME"];
    const TIMEOUT: Duration = Duration::from_secs(10);

    fn environment() -> [Option<Vec<u16>>; 2] {
        KEYS.map(|key| std::env::var_os(key).map(|value| value.encode_wide().collect()))
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct EnvironmentReport { pid: u32, parent_pid: u32, created_filetime: u64, in_job: bool, values: [Option<Vec<u16>>; 2], has_cron_token: bool }

    fn created_filetime(process: std::os::windows::io::RawHandle) -> u64 {
        let (mut created, mut exited, mut kernel, mut user): (FILETIME, FILETIME, FILETIME, FILETIME) = unsafe { std::mem::zeroed() };
        assert_ne!(unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }, 0);
        u64::from(created.dwHighDateTime) << 32 | u64::from(created.dwLowDateTime)
    }
    fn parent_pid() -> u32 {
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        assert_ne!(raw, INVALID_HANDLE_VALUE);
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32ProcessID == std::process::id() { return entry.th32ParentProcessID; }
            found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        }
        panic!("현재 fixture 프로세스의 부모 PID를 찾지 못했습니다.");
    }
    fn assert_exact_job(child: &NativeChild, job: &ProcessJob) {
        let mut owned = 0;
        assert_ne!(unsafe { IsProcessInJob(child.as_raw_handle(), job.as_handle().as_raw_handle(), &mut owned) }, 0);
        assert_ne!(owned, 0, "실제 직접 자식이 이 launch의 정확한 Job에 없습니다.");
    }

    // 실제 자식·Job·resume token을 함께 보유한다. 단언 실패도 suspended 자식을 회수한다.
    struct EnvironmentChild {
        child: NativeChild,
        job: Option<ProcessJob>,
        resume: Option<ResumeToken>,
        reports: Receiver<Result<EnvironmentReport, String>>,
        readers: Vec<JoinHandle<()>>,
        output: Arc<Mutex<[Vec<u8>; 2]>>,
    }
    impl EnvironmentChild {
        fn spawn(role: &str, values: Option<[OsString; 2]>) -> Self {
            let mut command = NativeCommand::new(std::env::current_exe().unwrap());
            command.args(["--ignored", "--exact", FIXTURE, "--nocapture"])
                .env("OPENDIY_LAUNCH_ENVIRONMENT_ROLE", role)
                .env("CODEX_DESKTOP_CRON_TOKEN", "시험용-상속금지-토큰")
                .env("CODEX_DESKTOP_CRON_BOOTSTRAP", "시험용-상속금지-bootstrap")
                .env_remove("CODEX_DESKTOP_CRON_TOKEN").env_remove("CODEX_DESKTOP_CRON_BOOTSTRAP")
                .stdin(NativeStdio::piped()).stdout(NativeStdio::piped()).stderr(NativeStdio::piped())
                .creation_flags(0x08000000); // CREATE_NO_WINDOW
            if let Some(values) = values { for (key, value) in KEYS.into_iter().zip(values) { command.env(key, value); } }
            let (sender, reports) = mpsc::channel();
            let job = ProcessJob::new(false).unwrap();
            let (child, resume) = spawn_suspended(&mut command, job.as_handle()).unwrap();
            assert_exact_job(&child, &job);
            let mut owned = Self { child, job: Some(job), resume: Some(resume), reports, readers: Vec::new(), output: Arc::new(Mutex::new([Vec::new(), Vec::new()])) };
            let output = owned.child.stdout.take().unwrap();
            let captured = owned.output.clone();
            owned.readers.push(thread::spawn(move || {
                let mut reader = BufReader::new(output);
                let mut bytes = Vec::new();
                loop {
                    bytes.clear();
                    match reader.read_until(b'\n', &mut bytes) {
                        Ok(0) => break,
                        Ok(_) => {
                            captured.lock().unwrap()[0].extend_from_slice(&bytes);
                            let line = String::from_utf8_lossy(&bytes);
                            if let Some(offset) = line.find(REPORT) {
                                let report = serde_json::from_str(&line[offset + REPORT.len()..]).map_err(|error| format!("환경 보고 형식: {error}"));
                                if sender.send(report).is_err() { break; }
                            }
                        }
                        Err(error) => { let _ = sender.send(Err(format!("환경 보고 읽기: {error}"))); break; }
                    }
                }
            }));
            let mut stderr = owned.child.stderr.take().unwrap();
            let captured = owned.output.clone();
            owned.readers.push(thread::spawn(move || { let mut bytes = Vec::new(); stderr.read_to_end(&mut bytes).unwrap(); captured.lock().unwrap()[1] = bytes; }));
            owned
        }

        fn resume(&mut self) { self.resume.take().unwrap().resume().unwrap(); }

        fn report(&self) -> EnvironmentReport {
            let report = self.reports.recv_timeout(TIMEOUT).expect("실제 자식의 환경 보고 시간 초과").unwrap();
            assert_eq!(report.pid, self.child.id(), "fixture는 본체가 직접 생성한 동일 자식이어야 합니다.");
            assert_eq!(report.parent_pid, std::process::id(), "중간 실행 프로세스가 있습니다.");
            assert_eq!(report.created_filetime, created_filetime(self.child.as_raw_handle()));
            assert!(report.in_job);
            // Exact membership was checked on this same process handle before
            // resume; a fast-exit fixture may already have left the active Job.
            assert!(!report.has_cron_token, "일반 자식에 예약 제어 토큰이 전달됐습니다.");
            println!("직접 실행 신원: pid={}, parentPid={}, createdFiletime={}, exactJobBeforeResume=true", report.pid, report.parent_pid, report.created_filetime);
            report
        }

        fn wait_until(&mut self, deadline: Instant) -> Result<ExitStatus, String> {
            loop {
                if let Some(status) = self.child.try_wait().map_err(|error| format!("직접 자식 종료 조회: {error}"))? { return Ok(status); }
                if Instant::now() >= deadline { return Err("직접 자식 종료 시간 초과".into()); }
                thread::sleep(Duration::from_millis(10));
            }
        }

        fn assert_reaped(&mut self) {
            let deadline = Instant::now() + TIMEOUT;
            while self.job.as_ref().unwrap().active_processes().unwrap() != 0 {
                assert!(Instant::now() < deadline, "시험 Job의 자손이 회수되지 않았습니다.");
                thread::sleep(Duration::from_millis(10));
            }
            self.child.wait().unwrap();
            for reader in self.readers.drain(..) { reader.join().unwrap(); }
        }
    }
    impl Drop for EnvironmentChild {
        fn drop(&mut self) {
            self.resume.take();
            self.job.take();
            let _ = self.child.kill();
            let _ = self.child.wait();
            for reader in self.readers.drain(..) { let _ = reader.join(); }
        }
    }

    #[test]
    fn native_child_preserves_environment_without_cross_launch_leaks() {
        let parent = environment();
        let homes = [OsString::from("시험용-활성-홈😀"), OsString::from_wide(&[0xD800, b'X' as u16])];
        let mut children = vec![
            EnvironmentChild::spawn("hold", Some(["1".into(), homes[0].clone()])),
            EnvironmentChild::spawn("hold", Some(["0".into(), homes[1].clone()])),
            EnvironmentChild::spawn("hold", None),
        ];
        assert_eq!(environment(), parent, "Command별 환경 설정이 부모를 바꿨습니다.");
        for child in &mut children {
            assert!(matches!(child.reports.try_recv(), Err(mpsc::TryRecvError::Empty)), "관문 해제 전에 실제 자식이 실행됐습니다.");
            child.resume();
        }
        let expected = [
            [Some("1".encode_utf16().collect()), Some(homes[0].encode_wide().collect())],
            [Some("0".encode_utf16().collect()), Some(homes[1].encode_wide().collect())],
            parent.clone(),
        ];
        for (child, expected) in children.iter().zip(expected) { assert_eq!(child.report().values, expected, "동시 자식의 환경이 섞이거나 상속값이 바뀌었습니다."); }
        assert!(children.iter_mut().all(|child| child.child.try_wait().unwrap().is_none()), "환경 비교 동안 모든 실제 자식이 함께 실행되어야 합니다.");
        assert_eq!(environment(), parent, "자식 실행이 부모 환경을 바꿨습니다.");
        for child in &mut children {
            child.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
            assert!(child.wait_until(Instant::now() + TIMEOUT).unwrap().success());
            child.assert_reaped();
        }
        assert_eq!(environment(), parent, "자식 회수 뒤 부모 환경이 바뀌었습니다.");
    }

    #[test]
    fn native_environment_fixture_reaps_failure_and_deadline_children() {
        let parent = environment();
        for role in ["fail", "hold"] {
            let mut child = EnvironmentChild::spawn(role, None);
            child.resume();
            assert_eq!(child.report().values, parent);
            if role == "fail" {
                assert!(!child.wait_until(Instant::now() + TIMEOUT).unwrap().success(), "실제 자식의 실패를 성공으로 바꿨습니다.");
            } else {
                assert!(child.wait_until(Instant::now()).unwrap_err().contains("시간 초과"));
                child.job.as_ref().unwrap().terminate().unwrap();
                child.wait_until(Instant::now() + TIMEOUT).unwrap();
            }
            child.assert_reaped();
        }
        assert_eq!(environment(), parent);
    }

    #[test]
    fn native_fast_exit_preserves_exact_exit_code_and_final_pipe_bytes() {
        for code in [0, 7] {
            let mut child = EnvironmentChild::spawn(&format!("exit{code}"), None);
            assert!(matches!(child.reports.try_recv(), Err(mpsc::TryRecvError::Empty)));
            child.resume();
            child.report();
            assert_eq!(child.wait_until(Instant::now() + TIMEOUT).unwrap().code(), Some(code));
            child.assert_reaped();
            let output = child.output.lock().unwrap();
            assert!(output[0].ends_with(format!("native-final-stdout:{code}\n").as_bytes()));
            assert!(output[1].ends_with(format!("native-final-stderr:{code}\n").as_bytes()));
            println!("빠른 종료: pid={}, exitCode={code}, finalStdout=true, finalStderr=true, jobActive=0", child.child.id());
        }
    }

    #[test]
    fn uncommitted_native_child_and_failed_resume_never_enter_and_reap_the_job() {
        for fail_resume in [false, true] {
            let mut child = EnvironmentChild::spawn("hold", None);
            assert!(matches!(child.reports.try_recv(), Err(mpsc::TryRecvError::Empty)));
            assert!(child.child.try_wait().unwrap().is_none());
            let mut resume = child.resume.take().unwrap();
            if fail_resume {
                resume.inject_resume_failure();
                assert!(resume.resume().unwrap_err().contains("resume owned process"));
            } else {
                // The same RAII path owns a failure after process acquisition
                // or reader/control setup, before launch is committed.
                drop(resume);
            }
            assert!(!child.wait_until(Instant::now() + TIMEOUT).unwrap().success());
            child.assert_reaped();
            assert!(child.reports.try_recv().is_err(), "실패한 시작에서 실제 프로그램이 실행됐습니다.");
            assert!(child.output.lock().unwrap().iter().all(Vec::is_empty), "실제 자식이 resume 전에 실행됐습니다.");
            println!("시작 실패 회수: pid={}, createdFiletime={}, injectedResumeFailure={fail_resume}, entered=false, jobActive=0", child.child.id(), created_filetime(child.child.as_raw_handle()));
        }
    }

    #[test]
    fn invalid_executable_and_invalid_job_fail_without_starting_a_process() {
        let job = ProcessJob::new(false).unwrap();
        let missing = std::env::temp_dir().join(format!("opendiy-missing-{}.exe", uuid::Uuid::new_v4()));
        let mut command = NativeCommand::new(missing);
        assert!(spawn_suspended(&mut command, job.as_handle()).is_err());
        assert_eq!(job.active_processes().unwrap(), 0);
        let raw = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        assert!(!raw.is_null());
        let event = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut command = NativeCommand::new(std::env::current_exe().unwrap());
        command.args(["--ignored", "--exact", FIXTURE, "--nocapture"]);
        // A live Event handle is deliberately not a Job handle. The kernel
        // must reject JOB_LIST before the fixture's first instruction.
        assert!(spawn_suspended(&mut command, unsafe { BorrowedHandle::borrow_raw(event.as_raw_handle()) }).is_err());
        assert_eq!(job.active_processes().unwrap(), 0);
    }

    #[test]
    #[ignore = "직접 실행 환경 시험의 실제 자식 진입점"]
    fn environment_fixture_child() {
        let role = std::env::var("OPENDIY_LAUNCH_ENVIRONMENT_ROLE").unwrap();
        let mut in_job = 0;
        assert_ne!(unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) }, 0);
        let report = EnvironmentReport { pid: std::process::id(), parent_pid: parent_pid(), created_filetime: created_filetime(unsafe { GetCurrentProcess() }), in_job: in_job != 0, values: environment(), has_cron_token: ["CODEX_DESKTOP_CRON_TOKEN", "CODEX_DESKTOP_CRON_BOOTSTRAP"].iter().any(|key| std::env::var_os(key).is_some()) };
        println!("\n{REPORT}{}", serde_json::to_string(&report).unwrap());
        std::io::stdout().flush().unwrap();
        if let Some(code) = role.strip_prefix("exit").map(|code| code.parse::<i32>().unwrap()) {
            eprintln!("native-final-stderr:{code}");
            println!("native-final-stdout:{code}");
            std::io::stderr().flush().unwrap();
            std::io::stdout().flush().unwrap();
            std::process::exit(code);
        }
        assert_ne!(role, "fail", "시험용 자식 실패");
        assert_eq!(role, "hold");
        let mut byte = [0];
        std::io::stdin().read_exact(&mut byte).unwrap();
        assert_eq!(byte, [b'x']);
    }
}
