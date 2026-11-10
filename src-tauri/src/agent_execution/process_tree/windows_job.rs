/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::{
    collections::HashMap,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::Duration,
};
use tokio::process::Child;
use windows::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, ERROR_NO_MORE_FILES, HANDLE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
            JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenProcess, OpenThread, ResumeThread, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            THREAD_SUSPEND_RESUME,
        },
    },
};

/// The handle is non-inheritable. Closing it (including on app termination) kills
/// every process in the job; breakaway is deliberately not enabled.
pub(super) struct Job(OwnedHandle);

impl Job {
    pub(super) fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(None, None) }.map_err(|error| error.to_string())?;
        // SAFETY: CreateJobObjectW transferred a unique, valid handle to us.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: The owned handle and correctly-sized limits live through the call.
        unsafe {
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|error| error.to_string())?;
        Ok(job)
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    pub(super) fn assign_and_resume(&self, child: &Child) -> Result<(), String> {
        let process = HANDLE(
            child
                .raw_handle()
                .ok_or("Missing suspended process handle")?,
        );
        // SAFETY: Both handles are borrowed from live owners; the process is suspended.
        unsafe { AssignProcessToJobObject(self.handle(), process) }
            .map_err(|error| error.to_string())?;
        resume_primary_thread(child.id().ok_or("Missing suspended process id")?)
    }

    pub(super) async fn stop(&self) -> Result<(), String> {
        let drained = tokio::time::timeout(Duration::from_secs(2), self.stop_members())
            .await
            .map_err(|_| "Timed out stopping command descendants".to_string())
            .and_then(|result| result);
        // SAFETY: This job exclusively owns the processes created for one command.
        // Always request job-wide termination, even if a member couldn't be opened
        // or its driver didn't finish pending I/O before the deadline.
        let terminated =
            unsafe { TerminateJobObject(self.handle(), 1) }.map_err(|error| error.to_string());
        drained.and(terminated)
    }

    /// Capture identity-bound handles before terminating members. Job accounting
    /// can reach zero before process resources (including listening ports) close.
    async fn stop_members(&self) -> Result<(), String> {
        let mut processes = HashMap::<u32, OwnedHandle>::new();
        loop {
            let before = processes.len();
            for pid in self.member_pids()? {
                if processes.contains_key(&pid) {
                    continue;
                }
                // SAFETY: OpenProcess validates the PID; membership below protects
                // against reuse between the job query and opening its handle.
                let handle = match unsafe {
                    OpenProcess(
                        PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                        false,
                        pid,
                    )
                } {
                    Ok(handle) => handle,
                    Err(error)
                        if error.code()
                            == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) =>
                    {
                        continue
                    }
                    Err(error) => return Err(error.to_string()),
                };
                // SAFETY: OpenProcess transferred a unique valid handle.
                let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
                let mut member = windows::core::BOOL::default();
                unsafe {
                    IsProcessInJob(
                        HANDLE(handle.as_raw_handle()),
                        Some(self.handle()),
                        &mut member,
                    )
                }
                .map_err(|error| error.to_string())?;
                if !member.as_bool() {
                    continue;
                }
                let process = HANDLE(handle.as_raw_handle());
                // Termination stops user code immediately, but I/O teardown is
                // asynchronous. Keep the handle until its signaled state proves exit.
                if let Err(error) = unsafe { TerminateProcess(process, 1) } {
                    if unsafe { WaitForSingleObject(process, 0) } != WAIT_OBJECT_0 {
                        return Err(error.to_string());
                    }
                }
                processes.insert(pid, handle);
            }
            if processes.len() == before {
                break;
            }
            // A member may have spawned a child before its termination request.
            // Re-query before job-wide termination removes the remaining PID list.
            tokio::task::yield_now().await;
        }
        for process in processes.values() {
            loop {
                // SAFETY: Each handle is retained until this wait completes.
                match unsafe { WaitForSingleObject(HANDLE(process.as_raw_handle()), 0) } {
                    WAIT_OBJECT_0 => break,
                    WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(10)).await,
                    _ => return Err(std::io::Error::last_os_error().to_string()),
                }
            }
        }
        Ok(())
    }

    fn member_pids(&self) -> Result<Vec<u32>, String> {
        let mut capacity = 16usize;
        loop {
            let bytes = std::mem::size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
                + (capacity - 1) * std::mem::size_of::<usize>();
            // usize storage gives the variable-sized Win32 structure its required alignment.
            let mut buffer = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let list = buffer
                .as_mut_ptr()
                .cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
            // SAFETY: The aligned buffer includes the header and `capacity` IDs.
            let result = unsafe {
                QueryInformationJobObject(
                    Some(self.handle()),
                    JobObjectBasicProcessIdList,
                    list.cast(),
                    bytes as u32,
                    None,
                )
            };
            match result {
                Ok(()) => {
                    // SAFETY: A successful query initialized this many IDs inside the buffer.
                    let ids = unsafe {
                        std::slice::from_raw_parts(
                            std::ptr::addr_of!((*list).ProcessIdList).cast::<usize>(),
                            (*list).NumberOfProcessIdsInList as usize,
                        )
                    };
                    return Ok(ids.iter().map(|pid| *pid as u32).collect());
                }
                Err(error)
                    if error.code() == windows::core::HRESULT::from_win32(ERROR_MORE_DATA.0) =>
                {
                    capacity *= 2
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

/// Stable Rust doesn't expose the initial thread handle from CreateProcess.
/// Locate that thread while the new process is still suspended, after job assignment.
fn resume_primary_thread(pid: u32) -> Result<(), String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
        .map_err(|error| error.to_string())?;
    // SAFETY: A successful snapshot transfers a valid owned handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
    let mut thread = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: The snapshot remains open and the entry buffer has its required size.
    unsafe { Thread32First(HANDLE(snapshot.as_raw_handle()), &mut thread) }
        .map_err(|error| error.to_string())?;
    loop {
        if thread.th32OwnerProcessID == pid {
            let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread.th32ThreadID) }
                .map_err(|error| error.to_string())?;
            // SAFETY: OpenThread transferred a unique valid handle.
            let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
            // SAFETY: The thread belongs to the suspended child, now assigned to our job.
            return if unsafe { ResumeThread(HANDLE(handle.as_raw_handle())) } == u32::MAX {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            };
        }
        match unsafe { Thread32Next(HANDLE(snapshot.as_raw_handle()), &mut thread) } {
            Ok(()) => {}
            Err(error)
                if error.code() == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) =>
            {
                return Err("Cannot find the suspended process's primary thread".into());
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}
