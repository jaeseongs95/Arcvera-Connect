//! O04: actual pre-resume child/Job/pipe ownership at worker acquisition failure.
use super::{Child,ProcessJob};
use std::{cell::RefCell, ffi::OsString, fs, os::windows::io::{AsRawHandle,BorrowedHandle,OwnedHandle},path::PathBuf,time::{Duration,Instant}};
use windows_sys::Win32::{Foundation::WAIT_OBJECT_0,System::{JobObjects::{QueryInformationJobObject,JobObjectBasicAccountingInformation,JOBOBJECT_BASIC_ACCOUNTING_INFORMATION},Threading::WaitForSingleObject}};

struct Resources { process:OwnedHandle, job:OwnedHandle }
thread_local! { static OBSERVED:RefCell<Option<Option<Resources>>> = const { RefCell::new(None) }; }
pub(super) fn observe(child:&Child,job:&ProcessJob) {
    OBSERVED.with(|slot| {
        let mut slot=slot.borrow_mut();
        if let Some(observed)=slot.as_mut() {
            assert!(observed.is_none(),"worker failure fixture launched an unexpected second child");
            // Keep the original process generation and Job, not a PID reopened
            // after teardown or a global process-name/count approximation.
            let process=unsafe {BorrowedHandle::borrow_raw(child.as_raw_handle())}.try_clone_to_owned().unwrap();
            *observed=Some(Resources {process,job:job.as_handle().try_clone_to_owned().unwrap()});
        }
    });
}
fn observing<R>(operation:impl FnOnce()->R)->(R,Resources) {
    struct Reset;
    impl Drop for Reset {fn drop(&mut self){OBSERVED.with(|slot|{slot.borrow_mut().take();});}}
    OBSERVED.with(|slot|{assert!(slot.borrow().is_none());*slot.borrow_mut()=Some(None);});
    let _reset=Reset;
    let result=operation();
    let resources=OBSERVED.with(|slot|slot.borrow_mut().as_mut().unwrap().take().expect("actual child/Job were not acquired before worker failure"));
    (result,resources)
}
impl Resources {
    fn assert_reaped(&self) {
        assert_eq!(unsafe {WaitForSingleObject(self.process.as_raw_handle(),1000)},WAIT_OBJECT_0,"failed worker launch retained its direct child");
        let deadline=Instant::now()+Duration::from_secs(3);
        loop {
            let mut accounting:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=unsafe{std::mem::zeroed()};
            assert_ne!(unsafe{QueryInformationJobObject(self.job.as_raw_handle(),JobObjectBasicAccountingInformation,&mut accounting as *mut _ as _,std::mem::size_of_val(&accounting) as u32,std::ptr::null_mut())},0);
            if accounting.ActiveProcesses==0 {break;}
            assert!(Instant::now()<deadline,"failed worker launch retained own Job descendants");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

struct Fixture { root:PathBuf, exe:OsString }
impl Fixture {
    fn new() -> Self {
        let root=std::env::temp_dir().join(format!("opendiy-worker-acquire-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source=root.join("fixture.cs");
        fs::write(&source,r#"using System; using System.Diagnostics; using System.IO; using System.Threading;
class WorkerFixture {
 static void Main(string[] args) {
  File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"entered.txt"),Process.GetCurrentProcess().Id.ToString());
  Thread.Sleep(30000);
 }
}"#).unwrap();
        let compile=root.join("compile.ps1");
        fs::write(&compile,"param([string]$SourcePath,[string]$DestinationPath)\n$ErrorActionPreference='Stop'\nAdd-Type -Path $SourcePath -OutputAssembly $DestinationPath -OutputType ConsoleApplication\n").unwrap();
        let exe=root.join("fixture.exe");
        let powershell=PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe").into_os_string();
        let args=vec!["-NoProfile".into(),"-NonInteractive".into(),"-ExecutionPolicy".into(),"Bypass".into(),"-File".into(),compile.to_string_lossy().into_owned(),"-SourcePath".into(),source.to_string_lossy().into_owned(),"-DestinationPath".into(),exe.to_string_lossy().into_owned()];
        // Reuse the existing native CLI runner before arming the failure scope.
        super::extensions::command_stdout(&powershell,&root,&args,Duration::from_secs(30)).unwrap();
        assert!(exe.is_file());
        Self {root,exe:exe.into_os_string()}
    }
    fn assert_not_entered(&self) {assert!(!self.root.join("entered.txt").exists(),"worker setup failure automatically ran the target program");}
}
impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}

fn assert_workers(first:usize) {
    let trace=crate::owned_worker::snapshot();
    assert_eq!(trace.failed,1,"{trace:?}");
    assert_eq!(trace.spawned,first,"{trace:?}");
    assert_eq!(trace.started_at_failure,first,"{trace:?}");
    assert_eq!(trace.finished_at_failure,0,"the preceding worker must still be alive at failure: {trace:?}");
    assert_eq!(trace.started,first,"{trace:?}");
    assert_eq!(trace.finished,first,"caller returned before its preceding worker finished: {trace:?}");
}

#[test]
fn worker_acquisition_failures_reap_proxy_expiry_and_cli_reader_without_entry() {
    let fixture=Fixture::new();
    for (name,preceding) in [("codex-proxy-deadline",0),("codex-proxy-reader",1)] {
        crate::owned_worker::fail_once(name,|| {
            let started=Instant::now();
            let (result,resources)=observing(||super::Proxy::open_until(&fixture.exe,None,Some(Instant::now()+Duration::from_secs(10))));
            let error=result.err().expect("worker acquisition failure must be returned");
            assert!(error.contains(name),"{error}");
            resources.assert_reaped();fixture.assert_not_entered();assert_workers(preceding);
            println!("worker acquisition: name={name}, targetNeverEntered=true, originalChildExited=true, ownJobEmpty=true, previousWorkerJoined=true, elapsed={:?}",started.elapsed());
        });
    }
    for (name,preceding) in [("codex-cli-stdout",0),("codex-cli-stderr",1)] {
        crate::owned_worker::fail_once(name,|| {
            let started=Instant::now();
            let (result,resources)=observing(||super::extensions::command_stdout(&fixture.exe,&fixture.root,&[],Duration::from_secs(10)));
            let error=result.unwrap_err();assert!(error.contains(name),"{error}");
            resources.assert_reaped();fixture.assert_not_entered();assert_workers(preceding);
            println!("worker acquisition: name={name}, targetNeverEntered=true, originalChildExited=true, ownJobEmpty=true, previousWorkersJoined=true, elapsed={:?}",started.elapsed());
        });
    }
}
