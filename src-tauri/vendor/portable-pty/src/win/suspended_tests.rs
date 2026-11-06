//! Isolated Windows process fixtures. No user configuration or external services.
use crate::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::{Read, Write};
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use winapi::um::{
    jobapi::IsProcessInJob,
    jobapi2::*,
    minwinbase::SECURITY_ATTRIBUTES,
    synchapi::{CreateEventW, SetEvent, WaitForSingleObject},
    winnt::*,
};

const FIXTURE: &str = "win::suspended_tests::fixture_child";
const ARGUMENT: &str = "한글 공백 \\\"quoted\\\" tail\\";
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Harness {
    directory: PathBuf,
    job: OwnedHandle,
    sentinel: OwnedHandle,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<Mutex<Vec<u8>>>,
    pair: Option<crate::PtyPair>,
    pump: Option<JoinHandle<()>>,
}
impl Harness {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "portable-pty-suspended-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let raw = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        assert!(!raw.is_null());
        let job = unsafe { OwnedHandle::from_raw_handle(raw as _) };
        let mut security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let sentinel = unsafe { CreateEventW(&mut security, 1, 0, std::ptr::null()) };
        assert!(!sentinel.is_null());
        let sentinel = unsafe { OwnedHandle::from_raw_handle(sentinel as _) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        assert_ne!(
            unsafe {
                SetInformationJobObject(
                    raw,
                    JobObjectExtendedLimitInformation,
                    &mut limits as *mut _ as _,
                    std::mem::size_of_val(&limits) as u32,
                )
            },
            0
        );
        let pair = native_pty_system().openpty(PtySize::default()).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let output = Arc::new(Mutex::new(Vec::new()));
        let (pumping_writer, captured) = (writer.clone(), output.clone());
        let pump = std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            let mut tail = Vec::new();
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let mut output = captured.lock().unwrap();
                        let remaining = (64 * 1024usize).saturating_sub(output.len());
                        output.extend_from_slice(&buffer[..count.min(remaining)]);
                        drop(output);
                        for byte in &buffer[..count] {
                            tail.push(*byte);
                            if tail.len() > 4 {
                                tail.remove(0);
                            }
                            if tail == b"\x1b[6n" {
                                let mut writer = pumping_writer.lock().unwrap();
                                if writer
                                    .write_all(b"\x1b[1;1R")
                                    .and_then(|_| writer.flush())
                                    .is_err()
                                {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        });
        Self {
            directory,
            job,
            sentinel,
            writer,
            output,
            pair: Some(pair),
            pump: Some(pump),
        }
    }
    fn job(&self) -> BorrowedHandle<'_> {
        unsafe { BorrowedHandle::borrow_raw(self.job.as_raw_handle()) }
    }
    fn command(&self) -> CommandBuilder {
        let mut command = CommandBuilder::new(std::env::current_exe().unwrap());
        command.args([
            "--ignored",
            "--exact",
            FIXTURE,
            "--nocapture",
            "--skip",
            ARGUMENT,
        ]);
        command.cwd(&self.directory);
        command.env("PORTABLE_PTY_SUSPENDED_FIXTURE", &self.directory);
        command.env("PORTABLE_PTY_SUSPENDED_VALUE", "한글 환경 값");
        command.env(
            "PORTABLE_PTY_UNRELATED_EVENT",
            (self.sentinel.as_raw_handle() as usize).to_string(),
        );
        command
    }
    fn assert_in_job(&self, child: &dyn crate::Child) {
        let mut belongs = 0;
        assert_ne!(
            unsafe {
                IsProcessInJob(
                    child.as_raw_handle().unwrap() as _,
                    self.job.as_raw_handle() as _,
                    &mut belongs,
                )
            },
            0
        );
        assert_ne!(
            belongs, 0,
            "the real target must already belong to this exact job"
        );
    }
    fn wait_output(&self, marker: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let output = String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned();
            if output.contains(marker) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "fixture output marker {:?} missing: {:?}",
                marker,
                output
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.job.as_raw_handle() as _, 1);
        }
        self.pair.take();
        if let Some(pump) = self.pump.take() {
            pump.join().unwrap();
        }
        fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[test]
fn suspended_target_is_owned_before_execution_and_preserves_command_data() {
    let harness = Harness::new();
    let suspended = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(harness.command(), harness.job())
        .unwrap();
    let (mut child, token) = suspended.into_parts();
    harness.assert_in_job(child.as_ref());
    let pid = child.process_id().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 100) },
        258
    );
    assert!(
        !harness.directory.join("entered").exists(),
        "target ran before commit"
    );
    token.resume().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 10_000) },
        0,
        "target did not exit after resume"
    );
    assert_eq!(child.wait().unwrap().exit_code(), 7);
    assert_eq!(
        fs::read_to_string(harness.directory.join("entered")).unwrap(),
        pid.to_string()
    );
    assert_eq!(
        unsafe { WaitForSingleObject(harness.sentinel.as_raw_handle() as _, 0) },
        258,
        "unrelated inheritable handle leaked into target"
    );
}

#[test]
fn terminated_job_cannot_commit_a_suspended_target() {
    let harness = Harness::new();
    let suspended = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(harness.command(), harness.job())
        .unwrap();
    let (mut child, mut token) = suspended.into_parts();
    assert_ne!(
        unsafe { TerminateJobObject(harness.job.as_raw_handle() as _, 1) },
        0
    );
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 10_000) },
        0
    );
    assert!(
        token.try_resume().is_err(),
        "a stopped launch must not commit successfully"
    );
    drop(token);
    assert!(!child.wait().unwrap().success());
    assert!(!harness.directory.join("entered").exists());
}

#[test]
fn direct_console_target_preserves_unicode_stdin_stdout_and_real_resize() {
    let harness = Harness::new();
    let mut command = harness.command();
    command.env("PORTABLE_PTY_SUSPENDED_MODE", "roundtrip");
    let suspended = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(command, harness.job())
        .unwrap();
    let (mut child, mut token) = suspended.into_parts();
    token.try_resume().unwrap();
    assert!(
        token.try_resume().is_err(),
        "a successful resume must not run twice"
    );
    harness.wait_output("roundtrip-ready");
    harness
        .pair
        .as_ref()
        .unwrap()
        .master
        .resize(PtySize {
            cols: 110,
            rows: 32,
            ..PtySize::default()
        })
        .unwrap();
    harness
        .writer
        .lock()
        .unwrap()
        .write_all("한글_🦀\r\n".as_bytes())
        .unwrap();
    harness.wait_output("roundtrip:한글_🦀;size=110x32");
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 10_000) },
        0
    );
    assert_eq!(child.wait().unwrap().exit_code(), 7);
}

#[test]
fn ordinary_spawn_remains_unsuspended_and_invalid_job_never_falls_back() {
    let harness = Harness::new();
    let mut child = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command(harness.command())
        .unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 10_000) },
        0
    );
    assert_eq!(child.wait().unwrap().exit_code(), 7);
    fs::remove_file(harness.directory.join("entered")).unwrap();
    let event = unsafe { CreateEventW(std::ptr::null_mut(), 1, 0, std::ptr::null()) };
    assert!(!event.is_null());
    let event = unsafe { OwnedHandle::from_raw_handle(event as _) };
    let non_job = unsafe { BorrowedHandle::borrow_raw(event.as_raw_handle()) };
    assert!(harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(harness.command(), non_job)
        .is_err());
    assert!(!harness.directory.join("entered").exists());
}

#[test]
fn dropping_uncommitted_launch_or_resume_token_reaps_the_real_target() {
    let harness = Harness::new();
    let suspended = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(harness.command(), harness.job())
        .unwrap();
    let (mut child, token) = suspended.into_parts();
    harness.assert_in_job(child.as_ref());
    drop(token);
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 10_000) },
        0
    );
    assert!(!child.wait().unwrap().success());
    assert!(!harness.directory.join("entered").exists());
    let suspended = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(harness.command(), harness.job())
        .unwrap();
    drop(suspended);
    let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
    assert_ne!(
        unsafe {
            QueryInformationJobObject(
                harness.job.as_raw_handle() as _,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        },
        0
    );
    assert_eq!(info.ActiveProcesses, 0, "uncommitted target remained");
    assert!(!harness.directory.join("entered").exists());
}

#[test]
fn wait_after_kill_or_job_termination_observes_original_handle_signaled() {
    let mut early = Vec::new();
    for mode in ["kill", "job"] {
        let harness = Harness::new();
        for iteration in 0..128 {
            let suspended = harness
                .pair
                .as_ref()
                .unwrap()
                .slave
                .spawn_command_in_job_suspended(harness.command(), harness.job())
                .unwrap();
            let (mut child, token) = suspended.into_parts();
            let raw = child.as_raw_handle().unwrap() as _;
            assert_eq!(unsafe { WaitForSingleObject(raw, 0) }, 258);
            if mode == "kill" {
                child.kill().unwrap();
            } else {
                assert_ne!(
                    unsafe { TerminateJobObject(harness.job.as_raw_handle() as _, 1) },
                    0
                );
            }
            let status = child.wait().unwrap();
            let signaled_at_return = unsafe { WaitForSingleObject(raw, 0) };
            if signaled_at_return != 0 {
                let mut observed_exit = 0;
                let queried = unsafe {
                    winapi::um::processthreadsapi::GetExitCodeProcess(raw, &mut observed_exit)
                };
                early.push((
                    mode,
                    iteration,
                    child.process_id(),
                    status.exit_code(),
                    signaled_at_return,
                    queried,
                    observed_exit,
                ));
            }
            // Record the original observation before awaiting actual cleanup.
            // Keep the same original handle alive throughout the comparison.
            assert_eq!(unsafe { WaitForSingleObject(raw, 10_000) }, 0);
            drop(token);
        }
        eprintln!(
            "actual wait boundary: mode={mode}, iterations=128, early_returns={}",
            early.iter().filter(|entry| entry.0 == mode).count()
        );
    }
    assert!(
        early.is_empty(),
        "wait returned before its original process handle signaled: {:?}",
        early
    );
}

#[test]
fn try_wait_recognizes_signaled_process_with_exit_code_259() {
    let harness = Harness::new();
    let mut command = harness.command();
    command.env("PORTABLE_PTY_SUSPENDED_EXIT_CODE", "259");
    let suspended = harness
        .pair
        .as_ref()
        .unwrap()
        .slave
        .spawn_command_in_job_suspended(command, harness.job())
        .unwrap();
    let (mut child, token) = suspended.into_parts();
    token.resume().unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(child.as_raw_handle().unwrap() as _, 10_000) },
        0
    );
    assert_eq!(
        child
            .try_wait()
            .unwrap()
            .expect("a signaled process is complete even when its exit code is STILL_ACTIVE")
            .exit_code(),
        259
    );
}

#[test]
#[ignore = "isolated suspended launch child entry point"]
fn fixture_child() {
    let directory = PathBuf::from(std::env::var_os("PORTABLE_PTY_SUSPENDED_FIXTURE").unwrap());
    assert_eq!(
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        directory.canonicalize().unwrap()
    );
    assert_eq!(
        std::env::var("PORTABLE_PTY_SUSPENDED_VALUE").unwrap(),
        "한글 환경 값"
    );
    assert_eq!(std::env::args_os().last().unwrap(), ARGUMENT);
    let unrelated = std::env::var("PORTABLE_PTY_UNRELATED_EVENT")
        .unwrap()
        .parse::<usize>()
        .unwrap();
    // Any accidentally inherited copy would signal the parent's exact event.
    unsafe {
        SetEvent(unrelated as _);
    }
    fs::write(directory.join("entered"), std::process::id().to_string()).unwrap();
    if std::env::var("PORTABLE_PTY_SUSPENDED_MODE").as_deref() == Ok("roundtrip") {
        use winapi::um::wincon::{
            GetConsoleScreenBufferInfo, SetConsoleCP, SetConsoleOutputCP,
            CONSOLE_SCREEN_BUFFER_INFO,
        };
        assert_ne!(unsafe { SetConsoleCP(65001) }, 0);
        assert_ne!(unsafe { SetConsoleOutputCP(65001) }, 0);
        println!("roundtrip-ready");
        std::io::stdout().flush().unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        assert_ne!(
            unsafe {
                GetConsoleScreenBufferInfo(std::io::stdout().as_raw_handle() as _, &mut info)
            },
            0
        );
        println!(
            "roundtrip:{};size={}x{}",
            input.trim_end_matches(['\r', '\n']),
            info.srWindow.Right - info.srWindow.Left + 1,
            info.srWindow.Bottom - info.srWindow.Top + 1
        );
        std::io::stdout().flush().unwrap();
    }
    let exit = std::env::var("PORTABLE_PTY_SUSPENDED_EXIT_CODE")
        .ok()
        .map(|value| value.parse().unwrap())
        .unwrap_or(7);
    std::process::exit(exit);
}
