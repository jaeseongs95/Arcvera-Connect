//! Direct Windows pipe children. Job membership and the primary-thread gate are
//! installed by CreateProcessW; no launcher process or global environment edit.
#[cfg(windows)]
mod platform {
    use std::{cmp::Ordering, ffi::OsStr, fs::{File, OpenOptions}, io, mem, os::windows::{ffi::OsStrExt, io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle}, process::ExitStatusExt}, path::Path, process::ExitStatus, ptr, sync::Arc};
    use windows_sys::Win32::{
        Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Globalization::{CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN},
        System::{JobObjects::TerminateJobObject, Pipes::CreatePipe, Threading::{CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess, InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW}},
    };

    pub type ChildStdin = File;

    #[derive(Debug)]
    pub enum Stdio { Null, Pipe, File(File) }
    impl Stdio {
        pub fn null() -> Self { Self::Null }
        pub fn piped() -> Self { Self::Pipe }
    }
    impl From<File> for Stdio { fn from(file: File) -> Self { Self::File(file) } }

    #[derive(Debug)]
    pub struct Command {
        command: std::process::Command,
        input: Stdio,
        output: Stdio,
        error: Stdio,
        flags: u32,
    }
    impl Command {
        pub fn new(program: impl AsRef<OsStr>) -> Self {
            Self { command: std::process::Command::new(program), input: Stdio::Null, output: Stdio::Null, error: Stdio::Null, flags: 0 }
        }
        pub fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self { self.command.arg(arg); self }
        pub fn args<I, S>(&mut self, args: I) -> &mut Self where I: IntoIterator<Item=S>, S: AsRef<OsStr> { self.command.args(args); self }
        pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self { self.command.env(key, value); self }
        pub fn envs<I, K, V>(&mut self, envs: I) -> &mut Self where I: IntoIterator<Item=(K,V)>, K: AsRef<OsStr>, V: AsRef<OsStr> { self.command.envs(envs); self }
        pub fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self { self.command.env_remove(key); self }
        pub fn current_dir(&mut self, dir: impl AsRef<Path>) -> &mut Self { self.command.current_dir(dir); self }
        pub fn creation_flags(&mut self, flags: u32) -> &mut Self { self.flags = flags; self }
        pub fn stdin(&mut self, stdio: impl Into<Stdio>) -> &mut Self { self.input = stdio.into(); self }
        pub fn stdout(&mut self, stdio: impl Into<Stdio>) -> &mut Self { self.output = stdio.into(); self }
        pub fn stderr(&mut self, stdio: impl Into<Stdio>) -> &mut Self { self.error = stdio.into(); self }
    }

    #[derive(Debug)]
    pub struct Child {
        process: Arc<OwnedHandle>,
        pid: u32,
        status: Option<ExitStatus>,
        pub stdin: Option<File>,
        pub stdout: Option<File>,
        pub stderr: Option<File>,
    }
    impl Child {
        pub fn id(&self) -> u32 { self.pid }
        pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if let Some(status) = self.status { return Ok(Some(status)); }
            match unsafe { WaitForSingleObject(self.as_raw_handle(), 0) } {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.as_raw_handle(), &mut code) } == 0 { return Err(io::Error::last_os_error()); }
                    let status = ExitStatus::from_raw(code);
                    self.status = Some(status);
                    Ok(Some(status))
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
        pub fn wait(&mut self) -> io::Result<ExitStatus> {
            self.stdin.take();
            if let Some(status) = self.try_wait()? { return Ok(status); }
            if unsafe { WaitForSingleObject(self.as_raw_handle(), INFINITE) } != WAIT_OBJECT_0 { return Err(io::Error::last_os_error()); }
            self.try_wait()?.ok_or_else(|| io::Error::other("owned child was not signalled after wait"))
        }
        pub fn kill(&mut self) -> io::Result<()> {
            if self.try_wait()?.is_some() { return Ok(()); }
            if unsafe { TerminateProcess(self.as_raw_handle(), 1) } != 0 { return Ok(()); }
            let error = io::Error::last_os_error();
            // The child may exit between the liveness check and termination.
            if self.try_wait()?.is_some() { Ok(()) } else { Err(error) }
        }
    }
    impl AsRawHandle for Child { fn as_raw_handle(&self) -> RawHandle { self.process.as_raw_handle() } }

    /// Dropping an uncommitted launch kills its own Job and waits for the direct
    /// child. The caller's ProcessJob remains the owner after successful resume.
    #[derive(Debug)]
    pub struct ResumeToken {
        process: Arc<OwnedHandle>, thread: OwnedHandle, job: OwnedHandle, armed: bool,
        #[cfg(test)] fail_resume_once: bool,
    }
    impl ResumeToken {
        #[cfg(test)]
        pub(crate) fn inject_resume_failure(&mut self) { self.fail_resume_once = true; }
        pub fn resume(mut self) -> Result<(), String> {
            #[cfg(test)]
            let thread = if self.fail_resume_once { ptr::null_mut() } else { self.thread.as_raw_handle() };
            #[cfg(not(test))]
            let thread = self.thread.as_raw_handle();
            let count = unsafe { ResumeThread(thread) };
            if count == 1 { self.armed = false; return Ok(()); }
            let error = if count == u32::MAX { format!("resume owned process: {}", io::Error::last_os_error()) }
                else { format!("resume owned process: unexpected previous suspend count {count}") };
            match self.abort() { Ok(()) => Err(error), Err(cleanup) => Err(format!("{error}; {cleanup}")) }
        }
        fn abort(&mut self) -> Result<(), String> {
            // The token only receives the new per-launch Job, never APP_JOB or
            // an external daemon's Job. Keep the token armed if cleanup fails.
            let job_result = unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) };
            let job_error = (job_result == 0).then(io::Error::last_os_error);
            let process_result = unsafe { TerminateProcess(self.process.as_raw_handle(), 1) };
            let process_error = (process_result == 0).then(io::Error::last_os_error);
            match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 5_000) } {
                WAIT_OBJECT_0 => {},
                WAIT_TIMEOUT => return Err(format!("uncommitted owned process did not exit within 5 seconds; job termination: {job_error:?}; process termination: {process_error:?}")),
                _ => return Err(format!("reap uncommitted owned process failed: {}; job termination: {job_error:?}; process termination: {process_error:?}", io::Error::last_os_error())),
            }
            if let Some(error) = job_error { return Err(format!("terminate uncommitted owned job: {error}")); }
            self.armed = false;
            Ok(())
        }
    }
    impl Drop for ResumeToken { fn drop(&mut self) { if self.armed { let _ = self.abort(); } } }

    fn wide(value: &OsStr, what: &str) -> Result<Vec<u16>, String> {
        let value: Vec<_> = value.encode_wide().collect();
        if value.contains(&0) { return Err(format!("{what} contains a NUL code unit")); }
        Ok(value)
    }
    fn compare_name(left: &[u16], right: &[u16]) -> Result<Ordering, String> {
        let left_len = i32::try_from(left.len()).map_err(|_| "environment key is too long")?;
        let right_len = i32::try_from(right.len()).map_err(|_| "environment key is too long")?;
        match unsafe { CompareStringOrdinal(left.as_ptr(), left_len, right.as_ptr(), right_len, 1) } {
            CSTR_LESS_THAN => Ok(Ordering::Less), CSTR_EQUAL => Ok(Ordering::Equal), CSTR_GREATER_THAN => Ok(Ordering::Greater),
            _ => Err(format!("compare environment keys: {}", io::Error::last_os_error())),
        }
    }
    fn environment(command: &std::process::Command) -> Result<Vec<u16>, String> {
        let mut entries = std::env::vars_os().map(|(key,value)| Ok((wide(&key,"environment key")?,wide(&value,"environment value")?))).collect::<Result<Vec<_>,String>>()?;
        for (key, value) in command.get_envs() {
            let key = wide(key, "environment key")?;
            if key.is_empty() || key.contains(&(b'=' as u16)) { return Err("invalid environment key".into()); }
            let mut index = 0;
            while index < entries.len() {
                if compare_name(&entries[index].0,&key)? == Ordering::Equal { entries.remove(index); } else { index += 1; }
            }
            if let Some(value) = value { entries.push((key, wide(value,"environment value")?)); }
        }
        let mut sort_error = None;
        entries.sort_by(|left,right| compare_name(&left.0,&right.0).unwrap_or_else(|error| { sort_error = Some(error); Ordering::Equal }));
        if let Some(error) = sort_error { return Err(error); }
        let mut block = Vec::new();
        for (key,value) in entries { block.extend(key); block.push(b'=' as u16); block.extend(value); block.push(0); }
        if block.is_empty() { block.push(0); }
        block.push(0);
        Ok(block)
    }
    fn quoted(arg: &[u16], output: &mut Vec<u16>) {
        output.push(b'"' as u16);
        let mut slashes = 0;
        for &unit in arg {
            if unit == b'\\' as u16 { slashes += 1; continue; }
            output.extend(std::iter::repeat_n(b'\\' as u16, slashes * if unit == b'"' as u16 { 2 } else { 1 }));
            if unit == b'"' as u16 { output.push(b'\\' as u16); }
            output.push(unit);
            slashes = 0;
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        output.push(b'"' as u16);
    }
    fn duplicate(handle: RawHandle, inherit: bool) -> Result<OwnedHandle, String> {
        let mut result = ptr::null_mut();
        let current = unsafe { GetCurrentProcess() };
        if unsafe { DuplicateHandle(current, handle, current, &mut result, 0, inherit.into(), DUPLICATE_SAME_ACCESS) } == 0 {
            return Err(format!("duplicate owned launch handle: {}", io::Error::last_os_error()));
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(result) })
    }
    struct IoHandles { child: OwnedHandle, parent: Option<File> }
    fn stdio(value: &Stdio, input: bool) -> Result<IoHandles, String> {
        let child = match value {
            Stdio::Null => {
                let null = OpenOptions::new().read(input).write(!input).open("NUL").map_err(|error| format!("open null stdio: {error}"))?;
                duplicate(null.as_raw_handle(), true)?
            }
            Stdio::File(file) => duplicate(file.as_raw_handle(), true)?,
            Stdio::Pipe => {
                let (mut read, mut write) = (ptr::null_mut(),ptr::null_mut());
                // The capture reader polls empty pipes every 20ms. A 64KiB
                // window avoids throttling bursts of small console writes.
                if unsafe { CreatePipe(&mut read,&mut write,ptr::null(),64 * 1024) } == 0 { return Err(format!("create owned stdio pipe: {}",io::Error::last_os_error())); }
                let read = unsafe { OwnedHandle::from_raw_handle(read) };
                let write = unsafe { OwnedHandle::from_raw_handle(write) };
                let (child,parent) = if input { (read,write) } else { (write,read) };
                return Ok(IoHandles { child: duplicate(child.as_raw_handle(),true)?, parent:Some(File::from(parent)) });
            }
        };
        Ok(IoHandles { child,parent:None })
    }

    struct Attributes { storage: Vec<usize> }
    impl Attributes {
        fn new() -> Result<Self,String> {
            let mut bytes = 0;
            unsafe { InitializeProcThreadAttributeList(ptr::null_mut(),2,0,&mut bytes); }
            if bytes == 0 { return Err(format!("size owned startup attributes: {}",io::Error::last_os_error())); }
            // usize storage supplies pointer alignment for the opaque Win32 list.
            let mut storage = vec![0usize;bytes.div_ceil(mem::size_of::<usize>())];
            if unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(),2,0,&mut bytes) } == 0 { return Err(format!("initialize owned startup attributes: {}",io::Error::last_os_error())); }
            Ok(Self { storage })
        }
        fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST { self.storage.as_mut_ptr().cast() }
        fn set(&mut self, key:u32, values:&[HANDLE]) -> Result<(),String> {
            if unsafe { UpdateProcThreadAttribute(self.as_ptr(),0,key as usize,values.as_ptr().cast(),mem::size_of_val(values),ptr::null_mut(),ptr::null()) } == 0 {
                return Err(format!("set owned startup attribute {key}: {}",io::Error::last_os_error()));
            }
            Ok(())
        }
    }
    impl Drop for Attributes { fn drop(&mut self) { unsafe { DeleteProcThreadAttributeList(self.as_ptr()); } } }

    pub fn spawn_suspended(command:&mut Command, job:BorrowedHandle<'_>) -> Result<(Child,ResumeToken),String> {
        let mut executable = wide(command.command.get_program(),"owned executable")?;
        if !Path::new(command.command.get_program()).is_absolute() { return Err("owned executable must have an absolute path".into()); }
        if executable.contains(&(b'"' as u16)) { return Err("owned executable contains a quote".into()); }
        let mut line = Vec::new();
        quoted(&executable,&mut line);
        for arg in command.command.get_args() { line.push(b' ' as u16); quoted(&wide(arg,"owned argument")?,&mut line); }
        line.push(0);
        if line.len() > 32_767 { return Err("owned command line exceeds the Windows limit".into()); }
        executable.push(0);
        let cwd = command.command.get_current_dir().map(|dir| wide(dir.as_os_str(),"owned current directory").map(|mut value| {value.push(0);value})).transpose()?;
        let environment = environment(&command.command)?;
        let input = stdio(&command.input,true)?;
        let output = stdio(&command.output,false)?;
        let error = stdio(&command.error,false)?;
        let job_handle = duplicate(job.as_raw_handle(),false)?;
        // Attribute values outlive the list; neither Job handle is inheritable.
        let jobs = [job_handle.as_raw_handle()];
        let inherited = [input.child.as_raw_handle(),output.child.as_raw_handle(),error.child.as_raw_handle()];
        let mut attrs = Attributes::new()?;
        attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST,&inherited)?;
        attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST,&jobs)?;
        let mut startup:STARTUPINFOEXW = unsafe { mem::zeroed() };
        startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inherited[0];
        startup.StartupInfo.hStdOutput = inherited[1];
        startup.StartupInfo.hStdError = inherited[2];
        startup.lpAttributeList = attrs.as_ptr();
        let mut process:PROCESS_INFORMATION = unsafe { mem::zeroed() };
        let created = unsafe { CreateProcessW(executable.as_ptr(),line.as_mut_ptr(),ptr::null(),ptr::null(),1,
            command.flags | CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),cwd.as_ref().map_or(ptr::null(),|dir|dir.as_ptr()),&startup.StartupInfo,&mut process) };
        if created == 0 { return Err(format!("create owned suspended process: {}",io::Error::last_os_error())); }
        let handle = Arc::new(unsafe { OwnedHandle::from_raw_handle(process.hProcess) });
        let thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
        let token = ResumeToken { process:handle.clone(),thread,job:job_handle,armed:true,
            #[cfg(test)] fail_resume_once:false,
        };
        // Remove the attribute list before its borrowed Job/stdio values drop.
        drop(attrs);
        let child = Child { process:handle,pid:process.dwProcessId,status:None,stdin:input.parent,stdout:output.parent,stderr:error.parent };
        Ok((child,token))
    }
}

#[cfg(windows)]
pub use platform::{spawn_suspended, Child, ChildStdin, Command, ResumeToken, Stdio};

#[cfg(not(windows))]
pub use std::process::{Child, ChildStdin, Command, Stdio};

#[cfg(not(windows))]
pub struct ResumeToken;
#[cfg(not(windows))]
impl ResumeToken { pub fn resume(self) -> Result<(),String> { Ok(()) } }
#[cfg(not(windows))]
pub fn spawn_suspended(command:&mut Command,_job:()) -> Result<(Child,ResumeToken),String> {
    command.spawn().map(|child|(child,ResumeToken)).map_err(|error|format!("spawn owned process: {error}"))
}
