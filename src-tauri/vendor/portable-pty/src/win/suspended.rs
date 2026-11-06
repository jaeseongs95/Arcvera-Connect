use crate::Child;
use anyhow::{bail, Context};
use filedescriptor::OwnedHandle;
use std::io;
use std::os::windows::io::AsRawHandle;
use winapi::shared::winerror::WAIT_TIMEOUT;
use winapi::um::{
    processthreadsapi::{ResumeThread, TerminateProcess},
    synchapi::WaitForSingleObject,
    winbase::WAIT_OBJECT_0,
};

/// A real PTY child that cannot run until its resume token is committed.
#[must_use = "dropping an uncommitted launch terminates its child"]
pub struct SuspendedPtyChild {
    child: Box<dyn Child + Send + Sync>,
    resume: ResumeToken,
}

impl SuspendedPtyChild {
    pub(crate) fn new(child: Box<dyn Child + Send + Sync>, resume: ResumeToken) -> Self {
        Self { child, resume }
    }

    pub fn into_parts(self) -> (Box<dyn Child + Send + Sync>, ResumeToken) {
        (self.child, self.resume)
    }
}

/// Owns the exact primary-thread handle returned by CreateProcessW and an
/// independent process handle until the caller commits the prepared launch.
#[must_use = "call resume after installing cleanup, or drop to terminate the child"]
pub struct ResumeToken {
    thread: Option<OwnedHandle>,
    pending: Option<OwnedHandle>,
}

impl ResumeToken {
    pub(crate) fn new(thread: OwnedHandle, process: OwnedHandle) -> Self {
        Self {
            thread: Some(thread),
            pending: Some(process),
        }
    }

    pub(crate) fn duplicate_process(&self) -> anyhow::Result<OwnedHandle> {
        Ok(self
            .pending
            .as_ref()
            .expect("uncommitted process")
            .try_clone()?)
    }

    /// Resume exactly once, terminating/reaping the child on failure. Do not call
    /// this consuming form while holding locks needed by process cleanup.
    pub fn resume(mut self) -> anyhow::Result<()> {
        if let Err(error) = self.try_resume() {
            if let Some(process) = self.pending.take() {
                if let Err(cleanup) = Self::terminate_pending(&process) {
                    return Err(
                        error.context(format!("terminate/reap failed PTY launch: {cleanup}"))
                    );
                }
            }
            self.pending.take();
            self.thread.take();
            return Err(error);
        }
        Ok(())
    }

    /// Only attempt the nonblocking commit. On error this token stays armed;
    /// the caller must drop it outside any metadata/cleanup lock. Success
    /// disarms pending cleanup and any second commit attempt is rejected.
    pub fn try_resume(&mut self) -> anyhow::Result<()> {
        let process = self
            .pending
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("owned PTY launch was already resumed"))?;
        match unsafe { WaitForSingleObject(process.as_raw_handle() as _, 0) } {
            WAIT_TIMEOUT => {}
            WAIT_OBJECT_0 => bail!("owned PTY process exited before resume"),
            _ => return Err(io::Error::last_os_error()).context("inspect owned PTY before resume"),
        }
        let previous = unsafe {
            ResumeThread(
                self.thread
                    .as_ref()
                    .expect("uncommitted primary thread")
                    .as_raw_handle() as _,
            )
        };
        if previous == u32::MAX {
            return Err(io::Error::last_os_error()).context("resume owned PTY primary thread");
        }
        if previous != 1 {
            bail!("owned PTY primary thread suspend count was {previous}, expected 1");
        }
        self.pending.take();
        self.thread.take();
        Ok(())
    }

    fn terminate_pending(process: &OwnedHandle) -> io::Result<()> {
        let raw = process.as_raw_handle() as _;
        if unsafe { WaitForSingleObject(raw, 0) } == WAIT_OBJECT_0 {
            return Ok(());
        }
        if unsafe { TerminateProcess(raw, 1) } == 0 {
            let error = io::Error::last_os_error();
            // The target may have completed concurrently with TerminateProcess.
            if unsafe { WaitForSingleObject(raw, 0) } == WAIT_OBJECT_0 {
                return Ok(());
            }
            return Err(error);
        }
        match unsafe { WaitForSingleObject(raw, 5_000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "uncommitted owned PTY did not terminate within five seconds",
            )),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

impl Drop for ResumeToken {
    fn drop(&mut self) {
        if let Some(process) = self.pending.take() {
            if let Err(error) = Self::terminate_pending(&process) {
                log::error!("terminate/reap uncommitted owned PTY: {error}");
            }
        }
    }
}
