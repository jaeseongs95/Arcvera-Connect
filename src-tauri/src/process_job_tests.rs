//! Windows 실제 Job 경계 시험. 별도 앱 시험 프로세스와 자체 fixture만 사용한다.
use super::{install_app_job, ProcessJob};
use crate::owned_process::{spawn_suspended, Command as NativeCommand, Stdio as NativeStdio};
use std::{
    fs,
    io::{Read, Write},
    os::windows::{io::{AsRawHandle, FromRawHandle, OwnedHandle}, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio as StdStdio},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, ERROR_ACCESS_DENIED, FILETIME, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
        JobObjects::IsProcessInJob,
        Threading::{GetCurrentProcess, GetExitCodeProcess, GetProcessId, GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, DETACHED_PROCESS, PROCESS_DUP_HANDLE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE}},
};

const FIXTURE: &str = "process_job::tests::job_fixture";
const TIMEOUT: Duration = Duration::from_secs(10);

/// 시험이 직접 생성한 프로세스만 열고, 실패 경로에서도 정리한다.
struct FixtureProcess { handle: OwnedHandle, cleanup: bool }
impl FixtureProcess {
    fn open(pid: u32) -> Self {
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!raw.is_null(), "시험 프로세스 {pid} 열기: {}", std::io::Error::last_os_error());
        Self { handle: unsafe { OwnedHandle::from_raw_handle(raw) }, cleanup: true }
    }
    fn open_record(record: ProcessRecord) -> Self {
        let process = Self::open(record.pid);
        assert_eq!(process.created_filetime(), record.created_filetime, "fixture PID의 생성 세대가 바뀌었습니다.");
        process
    }
    fn running(&self) -> bool {
        let result = unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) };
        assert!(matches!(result, WAIT_OBJECT_0 | WAIT_TIMEOUT), "시험 프로세스 대기 실패: {}", std::io::Error::last_os_error());
        result == WAIT_TIMEOUT
    }
    fn await_exit(&self) {
        assert_eq!(unsafe { WaitForSingleObject(self.handle.as_raw_handle(), TIMEOUT.as_millis() as u32) }, WAIT_OBJECT_0, "시험 프로세스가 종료되지 않았습니다.");
    }
    fn exit_code(&self) -> u32 {
        let mut code = 0;
        assert_ne!(unsafe { GetExitCodeProcess(self.handle.as_raw_handle(), &mut code) }, 0, "시험 프로세스 종료 코드 조회 실패: {}", std::io::Error::last_os_error());
        code
    }
    fn created_filetime(&self) -> u64 { created_filetime(self.handle.as_raw_handle()) }
    fn hand_off(mut self) { self.cleanup = false; }
}
impl Drop for FixtureProcess {
    fn drop(&mut self) {
        if self.cleanup {
            // 이미 종료된 경우도 안전하다. 핸들은 시험에서 얻은 동일 실행 세대를 가리킨다.
            unsafe { TerminateProcess(self.handle.as_raw_handle(), 1); WaitForSingleObject(self.handle.as_raw_handle(), 10_000); }
        }
    }
}

struct TestDirectory(PathBuf);
impl Drop for TestDirectory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn fixture_args() -> [&'static str; 4] { ["--ignored", "--exact", FIXTURE, "--nocapture"] }
fn configure(command: &mut StdCommand, directory: &Path, role: &str) {
    command.args(fixture_args()).env("OPENDIY_JOB_TEST_DIRECTORY", directory).env("OPENDIY_JOB_TEST_ROLE", role)
        .stdin(StdStdio::null()).stdout(StdStdio::null()).stderr(StdStdio::null()).creation_flags(CREATE_NO_WINDOW);
    if matches!(role, "query" | "daemon") {
        command.stderr(fs::File::create(directory.join(format!("{role}-stderr"))).unwrap());
    }
}
fn fixture_command(directory: &Path, role: &str) -> StdCommand {
    let mut command = StdCommand::new(std::env::current_exe().unwrap());
    configure(&mut command, directory, role);
    command
}
fn native_fixture_command(directory: &Path, role: &str) -> NativeCommand {
    let mut command = NativeCommand::new(std::env::current_exe().unwrap());
    command.args(fixture_args()).env("OPENDIY_JOB_TEST_DIRECTORY", directory).env("OPENDIY_JOB_TEST_ROLE", role)
        .stdin(NativeStdio::null()).stdout(NativeStdio::null()).stderr(fs::File::create(directory.join(format!("{role}-stderr"))).unwrap())
        .creation_flags(CREATE_NO_WINDOW);
    command
}
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
    panic!("현재 Job fixture의 부모 PID를 찾지 못했습니다.");
}
fn assert_exact_job(process: &FixtureProcess, job: &ProcessJob) {
    let mut owned = 0;
    assert_ne!(unsafe { IsProcessInJob(process.handle.as_raw_handle(), job.as_handle().as_raw_handle(), &mut owned) }, 0);
    assert_ne!(owned, 0, "정확한 session/query Job에 실제 직접 자식이 없습니다.");
}
fn publish(directory: &Path, name: &str, value: &impl serde::Serialize) {
    let path = directory.join(name);
    let temporary = path.with_extension("writing");
    fs::write(&temporary, serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(temporary, path).unwrap();
}
fn stage(directory: &Path, role: &str, step: &str) {
    fs::write(directory.join(format!("{role}-stage")), step).unwrap();
    eprintln!("Job 시험 단계: 역할={role}, 단계={step}");
}
fn diagnostics(directory: &Path) -> String {
    let mut records = Vec::new();
    for name in ["app-stage", "pty-stage", "query-stage", "daemon-stage", "pty-output", "pty-pump", "query-stderr", "daemon-stderr", "app-failure", "pty-failure", "query-failure", "daemon-failure"] {
        if let Ok(file) = fs::File::open(directory.join(name)) {
            let mut bytes = Vec::new();
            let result = file.take(4096).read_to_end(&mut bytes);
            records.push(format!("{name}={:?}, 읽기={result:?}", String::from_utf8_lossy(&bytes)));
        }
    }
    records.join("; ")
}
fn receive<T: serde::de::DeserializeOwned>(directory: &Path, name: &str, watched: Option<&FixtureProcess>) -> T {
    let started = Instant::now();
    loop {
        match fs::read(directory.join(name)) {
            Ok(bytes) => return serde_json::from_slice(&bytes).unwrap(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(process) = watched {
                    assert!(process.running(), "시험 응답 {name} 이전 자식 종료: 코드={}, {}", process.exit_code(), diagnostics(directory));
                }
                assert!(started.elapsed() < TIMEOUT, "시험 응답 {name} 시간 초과: {}", diagnostics(directory));
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("시험 응답 {name} 읽기: {error}"),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SpawnReport { entry: EntryReport, detached: Option<ProcessRecord>, blocked: Option<i32>, ordinary: ProcessRecord }
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct EntryReport { pid: u32, parent_pid: u32, created_filetime: u64, in_job: bool }
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct ProcessRecord { pid: u32, created_filetime: u64 }
#[derive(serde::Serialize, serde::Deserialize)]
struct PendingReport { app: ProcessRecord, target: ProcessRecord, job_handle: usize }
fn child_record(child: &std::process::Child) -> ProcessRecord {
    ProcessRecord { pid: child.id(), created_filetime: created_filetime(child.as_raw_handle()) }
}

fn check_launcher(job: ProcessJob, launcher: &FixtureProcess, directory: &Path, role: &str) -> Option<FixtureProcess> {
    stage(directory, role, "자손 보고 대기");
    let report: SpawnReport = receive(directory, role, Some(launcher));
    assert_eq!(report.entry.pid, unsafe { GetProcessId(launcher.handle.as_raw_handle()) });
    assert_eq!(report.entry.parent_pid, std::process::id(), "실제 launcher 앞에 중간 helper가 있습니다.");
    assert_eq!(report.entry.created_filetime, launcher.created_filetime());
    assert!(report.entry.in_job);
    assert_exact_job(launcher, &job);
    eprintln!("직접 실행 신원: role={role}, pid={}, parentPid={}, createdFiletime={}, exactJob=true", report.entry.pid, report.entry.parent_pid, report.entry.created_filetime);
    // 판정 전에 성공한 모든 fixture를 소유해 예상 밖 분리도 정리한다.
    let detached = report.detached.map(FixtureProcess::open_record);
    let ordinary = FixtureProcess::open_record(report.ordinary);
    assert!(ordinary.running());
    if role == "daemon" {
        assert!(detached.as_ref().is_some_and(FixtureProcess::running), "전용 실행기의 명시 분리가 거절됐습니다. 외부 Job 제한도 확인하십시오: {:?}", report.blocked);
        assert!(report.blocked.is_none());
    } else {
        assert!(detached.is_none(), "일반 {role} 실행기에서 분리를 허용했습니다.");
        assert_eq!(report.blocked, Some(ERROR_ACCESS_DENIED as i32));
    }
    stage(directory, role, "분리 판정 완료, Job 닫기");
    drop(job);
    launcher.await_exit();
    ordinary.await_exit();
    if let Some(process) = &detached { assert!(process.running(), "전용 실행기 Job 종료가 daemon을 종료했습니다."); }
    stage(directory, role, "일반 자손 회수 확인");
    detached
}

fn app_fixture(directory: &Path) {
    // 전체 시험 실행기를 APP_JOB에 넣지 않도록 이 fixture 프로세스에서만 설치한다.
    install_app_job().unwrap();
    stage(directory, "app", "앱 Job 설치 완료, PTY 검사 시작");
    pty_fixture(directory);
    for role in ["query", "daemon"] {
        stage(directory, "app", &format!("{role} 실행기 생성"));
        let mut command = native_fixture_command(directory, role);
        let job = ProcessJob::new(role == "daemon").unwrap();
        let (mut child, resume) = spawn_suspended(&mut command, job.as_handle()).unwrap();
        let launcher = FixtureProcess::open(child.id());
        assert_exact_job(&launcher, &job);
        assert!(!directory.join(format!("{role}-entered")).exists(), "resume 전에 fixture가 실행됐습니다.");
        resume.resume().unwrap();
        stage(directory, role, "실행 게이트 해제");
        let detached = check_launcher(job, &launcher, directory, role);
        child.wait().unwrap();
        if let Some(detached) = detached {
            // launcher Job이 닫힌 뒤에도 앱 Job만 상속한 일반 자식은 살아 있다.
            let child = fixture_command(directory, "sleeper").spawn().unwrap();
            let ordinary = FixtureProcess::open(child.id());
            assert!(ordinary.running());
            let report: SpawnReport = receive(directory, "daemon", None);
            stage(directory, "app", "daemon 분리 확인, 앱 종료 지시 대기");
            publish(directory, "app-ready", &(report.detached.unwrap(), child_record(&child)));
            let _: bool = receive(directory, "finish-app", None);
            detached.hand_off();
            ordinary.hand_off();
        }
    }
}

fn pending_app_fixture(directory: &Path) {
    install_app_job().unwrap();
    let job = ProcessJob::new(false).unwrap();
    let mut command = native_fixture_command(directory, "query");
    let (mut child, resume) = spawn_suspended(&mut command, job.as_handle()).unwrap();
    let target = FixtureProcess::open(child.id());
    assert_exact_job(&target, &job);
    assert!(!directory.join("query-entered").exists());
    publish(directory, "pending-app-ready", &PendingReport {
        app: ProcessRecord { pid: std::process::id(), created_filetime: created_filetime(unsafe { GetCurrentProcess() }) },
        target: ProcessRecord { pid: child.id(), created_filetime: created_filetime(child.as_raw_handle()) },
        job_handle: job.as_handle().as_raw_handle() as usize,
    });
    // The external test kills this supervisor while it owns both Job handles,
    // including ResumeToken's duplicate. No token resume or Rust Drop may run.
    std::thread::sleep(Duration::from_secs(30));
    assert!(child.try_wait().unwrap().is_none());
    drop(resume);
    panic!("외부 시험이 pending supervisor를 제한 시간 안에 종료하지 않았습니다.");
}

fn pty_fixture(directory: &Path) {
    stage(directory, "pty", "가상 터미널 생성");
    let pair = portable_pty::native_pty_system().openpty(portable_pty::PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let mut writer = pair.master.take_writer().unwrap();
    let output_directory = directory.to_path_buf();
    let output = std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
        let mut captured = fs::File::create(output_directory.join("pty-output")).map_err(|error| error.to_string())?;
        let mut buffer = [0u8; 4096];
        let (mut retained, mut queries) = (0usize, 0usize);
        let mut tail = Vec::new();
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => break,
                Err(error) => return Err(format!("PTY 출력 읽기: {error}")),
            };
            let keep = count.min((16 * 1024usize).saturating_sub(retained));
            captured.write_all(&buffer[..keep]).map_err(|error| error.to_string())?;
            captured.flush().map_err(|error| error.to_string())?;
            retained += keep;
            for byte in &buffer[..count] {
                tail.push(*byte);
                if tail.len() > 4 { tail.remove(0); }
                // ConPTY의 커서 상속 질의는 분할 수신될 수 있다. 사용자 입력은 보내지 않는다.
                if tail.as_slice() == b"\x1b[6n" {
                    writer.write_all(b"\x1b[1;1R").and_then(|_| writer.flush()).map_err(|error| format!("PTY 커서 응답: {error}"))?;
                    queries += 1;
                    fs::write(output_directory.join("pty-pump"), format!("커서 응답={queries}, 보관 바이트={retained}")).map_err(|error| error.to_string())?;
                }
            }
        }
        fs::write(output_directory.join("pty-pump"), format!("출력 종료, 커서 응답={queries}, 보관 바이트={retained}")).map_err(|error| error.to_string())?;
        Ok(())
        })();
        if let Err(error) = &result { let _ = fs::write(output_directory.join("pty-pump"), error); }
        result
    });
    stage(directory, "pty", "출력 소비 시작, 실행기 생성");
    let mut command = portable_pty::CommandBuilder::new(std::env::current_exe().unwrap());
    command.args(fixture_args());
    command.env("OPENDIY_JOB_TEST_DIRECTORY", directory);
    command.env("OPENDIY_JOB_TEST_ROLE", "pty");
    let job = ProcessJob::new(false).unwrap();
    let suspended = pair.slave.spawn_command_in_job_suspended(command, job.as_handle()).unwrap();
    let (mut child, resume) = suspended.into_parts();
    stage(directory, "pty", "실제 자식 suspended 생성 완료, Job 확인");
    let launcher = FixtureProcess::open(child.process_id().unwrap());
    assert_exact_job(&launcher, &job);
    assert!(!directory.join("pty-entered").exists(), "PTY resume 전에 fixture가 실행됐습니다.");
    resume.resume().unwrap();
    stage(directory, "pty", "실행 게이트 해제");
    assert!(check_launcher(job, &launcher, directory, "pty").is_none());
    child.wait().unwrap();
    stage(directory, "pty", "실행기 회수 완료, 가상 터미널 닫기");
    drop(pair);
    stage(directory, "pty", "가상 터미널 닫힘, 출력 소비 완료 대기");
    output.join().unwrap().unwrap();
    eprintln!("Job 시험 터미널 협상: {}", fs::read_to_string(directory.join("pty-pump")).unwrap());
    stage(directory, "pty", "출력 소비 완료");
}

#[test]
fn only_daemon_launcher_can_outlive_launcher_and_app_jobs() {
    for abrupt in [false, true] {
        let directory = TestDirectory(std::env::temp_dir().join(format!("opendiy-job-test-{}", uuid::Uuid::new_v4())));
        fs::create_dir(&directory.0).unwrap();
        let mut app = fixture_command(&directory.0, "app").stdout(StdStdio::inherit()).stderr(StdStdio::inherit()).spawn().unwrap();
        let app_process = FixtureProcess::open(app.id());
        let (daemon_record, ordinary_record): (ProcessRecord, ProcessRecord) = receive(&directory.0, "app-ready", Some(&app_process));
        let daemon = FixtureProcess::open_record(daemon_record);
        let ordinary = FixtureProcess::open_record(ordinary_record);
        assert!(daemon.running());
        assert!(ordinary.running());
        if abrupt {
            // Kill only the held handle of this isolated app fixture. No Rust
            // destructors run, so recovery must come from OS Job handle close.
            assert_ne!(unsafe { TerminateProcess(app_process.handle.as_raw_handle(), 87) }, 0);
        } else { publish(&directory.0, "finish-app", &true); }
        app_process.await_exit();
        let status = app.wait().unwrap();
        if abrupt { assert_eq!(status.code(), Some(87)); }
        else { assert!(status.success(), "격리된 앱 Job 시험이 실패했습니다."); }
        ordinary.await_exit();
        assert!(daemon.running(), "앱 종료가 분리된 daemon을 종료했습니다.");
        eprintln!("앱 Job 회수: abrupt={abrupt}, appPid={}, appCreatedFiletime={}, ordinaryPid={}, ordinaryCreatedFiletime={}, daemonPid={}, daemonCreatedFiletime={}, appExited=true, ordinaryExited=true, daemonAlive=true",
            app.id(), app_process.created_filetime(), ordinary_record.pid, ordinary_record.created_filetime, daemon_record.pid, daemon_record.created_filetime);
    }
}

#[test]
fn abrupt_app_exit_reaps_uncommitted_suspended_target_without_drop() {
    let directory = TestDirectory(std::env::temp_dir().join(format!("opendiy-pending-job-test-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&directory.0).unwrap();
    let mut app = fixture_command(&directory.0, "app-pending").stdout(StdStdio::inherit()).stderr(StdStdio::inherit()).spawn().unwrap();
    let app_process = FixtureProcess::open(app.id());
    let report: PendingReport = receive(&directory.0, "pending-app-ready", Some(&app_process));
    assert_eq!(report.app.pid, app.id());
    assert_eq!(report.app.created_filetime, app_process.created_filetime());
    let target = FixtureProcess::open_record(report.target);
    assert!(target.running());

    // Duplicate only this still-live fixture's exact Job for an external
    // membership check. Its creation time binds OpenProcess to the held app.
    let raw = unsafe { OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, 0, app.id()) };
    assert!(!raw.is_null());
    let source = unsafe { OwnedHandle::from_raw_handle(raw) };
    assert_eq!(created_filetime(source.as_raw_handle()), report.app.created_filetime);
    let mut copied = std::ptr::null_mut();
    assert_ne!(unsafe { DuplicateHandle(source.as_raw_handle(), report.job_handle as std::os::windows::io::RawHandle,
        GetCurrentProcess(), &mut copied, 0, 0, DUPLICATE_SAME_ACCESS) }, 0);
    let exact_job = unsafe { OwnedHandle::from_raw_handle(copied) };
    let mut member = 0;
    assert_ne!(unsafe { IsProcessInJob(target.handle.as_raw_handle(), exact_job.as_raw_handle(), &mut member) }, 0);
    assert_ne!(member, 0, "외부 관측 대상이 pending launch의 정확한 Job에 없습니다.");
    assert!(!directory.0.join("query-entered").exists(), "미commit target이 resume 전에 실행됐습니다.");
    // Keeping this duplicate across the crash would invalidate KILL_ON_CLOSE.
    drop(exact_job);
    drop(source);

    assert_ne!(unsafe { TerminateProcess(app_process.handle.as_raw_handle(), 89) }, 0);
    app_process.await_exit();
    assert_eq!(app.wait().unwrap().code(), Some(89));
    target.await_exit();
    assert!(!directory.0.join("query-entered").exists(), "supervisor crash 뒤 pending target이 실행됐습니다.");
    eprintln!("미commit 시작 crash 회수: appPid={}, appCreatedFiletime={}, targetPid={}, targetCreatedFiletime={}, exactJobBeforeCrash=true, entered=false, appExited=true, targetSignaled=true",
        report.app.pid, report.app.created_filetime, report.target.pid, report.target.created_filetime);
}

#[test]
#[ignore = "자체 시험 프로세스의 진입점"]
fn job_fixture() {
    let Ok(directory) = std::env::var("OPENDIY_JOB_TEST_DIRECTORY") else { return; };
    let directory = Path::new(&directory);
    let role = std::env::var("OPENDIY_JOB_TEST_ROLE").unwrap();
    let failure_path = directory.join(format!("{role}-failure"));
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |information| {
        let _ = fs::write(&failure_path, information.to_string());
        previous_hook(information);
    }));
    if role != "sleeper" { stage(directory, &role, "자체 시험 진입"); }
    if role == "app" {
        app_fixture(directory);
    } else if role == "app-pending" {
        pending_app_fixture(directory);
    } else if role == "sleeper" {
        // 시험 도중 부모가 강제 종료돼도 fixture는 무한히 남지 않는다.
        std::thread::sleep(Duration::from_secs(30));
    } else {
        assert!(matches!(role.as_str(), "query" | "pty" | "daemon"));
        let mut in_job = 0;
        assert_ne!(unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) }, 0);
        let entry = EntryReport { pid: std::process::id(), parent_pid: parent_pid(), created_filetime: created_filetime(unsafe { GetCurrentProcess() }), in_job: in_job != 0 };
        publish(directory, &format!("{role}-entered"), &entry);
        let mut detached_command = fixture_command(directory, "sleeper");
        detached_command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB);
        stage(directory, &role, "명시 분리 자식 생성");
        let detached = detached_command.spawn();
        let (detached, blocked) = match detached {
            Ok(child) => (Some(child), None),
            Err(error) => (None, error.raw_os_error()),
        };
        stage(directory, &role, &format!("명시 분리 결과 확인: 오류={blocked:?}, 일반 자식 생성"));
        let ordinary = fixture_command(directory, "sleeper").spawn().unwrap();
        publish(directory, &role, &SpawnReport { entry, detached: detached.as_ref().map(child_record), blocked, ordinary: child_record(&ordinary) });
        stage(directory, &role, "자손 보고 게시 완료");
        std::thread::sleep(Duration::from_secs(30));
        if let Some(mut child) = detached { let _ = child.kill(); let _ = child.wait(); }
        let mut ordinary = ordinary;
        let _ = ordinary.kill();
        let _ = ordinary.wait();
    }
}
