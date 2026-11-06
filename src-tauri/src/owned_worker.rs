//! Fallible creation of the owned readers/watchers installed before child resume.
use std::{io, thread::{self, JoinHandle}};

pub(crate) fn spawn<T, F>(name: &'static str, task: F) -> io::Result<JoinHandle<T>>
where T: Send + 'static, F: FnOnce() -> T + Send + 'static {
    #[cfg(test)]
    let scope = testing::before_spawn(name)?;
    let result = thread::Builder::new().name(name.into()).spawn(move || {
        #[cfg(test)]
        let _finished = testing::Running::new(scope);
        task()
    });
    #[cfg(test)]
    if result.is_ok() { testing::spawned(); }
    result
}

#[cfg(test)]
mod testing {
    use std::{cell::RefCell, io, sync::{Arc, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant}};

    #[derive(Default)]
    pub(super) struct Trace {
        spawned: AtomicUsize, started: AtomicUsize, finished: AtomicUsize, failed: AtomicUsize,
        started_at_failure: AtomicUsize, finished_at_failure: AtomicUsize,
    }
    struct Scope { name: &'static str, fired: bool, trace: Arc<Trace> }
    thread_local! { static CURRENT: RefCell<Option<Scope>> = const { RefCell::new(None) }; }

    #[derive(Debug, Default)]
    pub(crate) struct Snapshot {
        pub spawned: usize, pub started: usize, pub finished: usize, pub failed: usize,
        pub started_at_failure: usize, pub finished_at_failure: usize,
    }
    pub(crate) fn snapshot() -> Snapshot {
        CURRENT.with(|current| current.borrow().as_ref().map(|scope| {
            let trace = &scope.trace;
            Snapshot {
                spawned: trace.spawned.load(Ordering::Acquire), started: trace.started.load(Ordering::Acquire),
                finished: trace.finished.load(Ordering::Acquire), failed: trace.failed.load(Ordering::Acquire),
                started_at_failure: trace.started_at_failure.load(Ordering::Acquire), finished_at_failure: trace.finished_at_failure.load(Ordering::Acquire),
            }
        }).unwrap_or_default())
    }
    pub(crate) fn fail_once<R>(name: &'static str, operation: impl FnOnce() -> R) -> R {
        struct Restore(Option<Scope>);
        impl Drop for Restore { fn drop(&mut self) { CURRENT.with(|current| { *current.borrow_mut() = self.0.take(); }); } }
        let previous = CURRENT.with(|current| current.replace(Some(Scope {name, fired:false, trace:Arc::new(Trace::default())})));
        let _restore = Restore(previous);
        operation()
    }
    pub(super) fn before_spawn(name: &'static str) -> io::Result<Option<Arc<Trace>>> {
        let (trace, fail) = CURRENT.with(|current| {
            let mut current = current.borrow_mut();
            let Some(scope) = current.as_mut() else { return (None,false); };
            let fail = scope.name == name && !scope.fired;
            if fail { scope.fired = true; }
            (Some(scope.trace.clone()),fail)
        });
        if fail {
            let trace = trace.as_ref().unwrap();
            // The test failure boundary must observe preceding successful
            // workers actually alive, rather than merely queued by the OS.
            let deadline = Instant::now() + Duration::from_secs(1);
            while trace.started.load(Ordering::Acquire) < trace.spawned.load(Ordering::Acquire) {
                assert!(Instant::now() < deadline, "owned worker did not enter before injected failure");
                std::thread::yield_now();
            }
            trace.started_at_failure.store(trace.started.load(Ordering::Acquire), Ordering::Release);
            trace.finished_at_failure.store(trace.finished.load(Ordering::Acquire), Ordering::Release);
            trace.failed.fetch_add(1, Ordering::Release);
            return Err(io::Error::other(format!("injected owned worker creation failure: {name}")));
        }
        Ok(trace)
    }
    pub(super) fn spawned() {
        CURRENT.with(|current| { if let Some(scope) = current.borrow().as_ref() { scope.trace.spawned.fetch_add(1,Ordering::Release); } });
    }
    pub(super) struct Running(Option<Arc<Trace>>);
    impl Running {
        pub(super) fn new(trace: Option<Arc<Trace>>) -> Self {
            if let Some(trace) = &trace { trace.started.fetch_add(1,Ordering::Release); }
            Self(trace)
        }
    }
    impl Drop for Running {
        fn drop(&mut self) { if let Some(trace) = &self.0 { trace.finished.fetch_add(1,Ordering::Release); } }
    }
}

#[cfg(test)]
pub(crate) use testing::{fail_once, snapshot, Snapshot};

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

    #[test]
    fn failure_is_once_local_and_drops_the_rejected_task_capture() {
        struct Capture(Arc<AtomicBool>);
        impl Drop for Capture { fn drop(&mut self) { self.0.store(true,Ordering::Release); } }
        let dropped = Arc::new(AtomicBool::new(false));
        fail_once("reject", || {
            spawn("other", || 17).unwrap().join().unwrap();
            let capture = Capture(dropped.clone());
            assert!(spawn("reject", move || drop(capture)).is_err());
            assert!(dropped.load(Ordering::Acquire));
            assert_eq!(spawn("reject", || 23).unwrap().join().unwrap(),23);
            let trace = snapshot();
            assert_eq!((trace.spawned,trace.started,trace.finished,trace.failed),(2,2,2,1));
        });
        assert_eq!(snapshot().failed,0);
    }

    #[test]
    fn nested_scopes_restore_and_do_not_inject_into_another_os_thread() {
        fail_once("outer", || {
            thread::spawn(|| spawn("outer",||()).unwrap().join().unwrap()).join().unwrap();
            assert_eq!(snapshot().spawned,0);
            fail_once("inner", || { assert!(spawn("inner",||()).is_err()); assert_eq!(snapshot().failed,1); });
            assert_eq!(snapshot().failed,0);
            assert!(spawn("outer",||()).is_err());
            assert_eq!(snapshot().failed,1);
        });
    }

    #[test]
    fn failure_observes_a_preceding_live_worker_and_its_final_join() {
        fail_once("second",|| {
            let (release,receive)=std::sync::mpsc::channel();
            let first=spawn("first",move||receive.recv().unwrap()).unwrap();
            assert!(spawn("second",||()).is_err());
            let trace=snapshot();
            assert_eq!((trace.spawned,trace.started_at_failure,trace.finished_at_failure),(1,1,0));
            release.send(()).unwrap();first.join().unwrap();
            assert_eq!(snapshot().finished,1);
        });
    }
}
