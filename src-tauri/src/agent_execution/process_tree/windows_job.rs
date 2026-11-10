/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::Duration,
};
use tokio::process::Child;
use windows::Win32::{
    Foundation::{ERROR_NO_MORE_FILES, HANDLE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
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
        // SAFETY: This job exclusively owns the processes created for one command.
        unsafe { TerminateJobObject(self.handle(), 1) }.map_err(|error| error.to_string())?;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
                // TerminateJobObject is asynchronous. Wait for all descendants,
                // including ones whose root exited, before releasing ports/restarting.
                // SAFETY: The output buffer's layout and size match the query class.
                unsafe {
                    QueryInformationJobObject(
                        Some(self.handle()),
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as _,
                        std::mem::size_of_val(&accounting) as u32,
                        None,
                    )
                }
                .map_err(|error| error.to_string())?;
                if accounting.ActiveProcesses == 0 {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| "Timed out stopping command descendants".to_string())?
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
