/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#[cfg(unix)]
use std::time::Duration;
use tokio::process::{Child, Command};
#[cfg(windows)]
#[path = "process_tree/windows_job.rs"]
mod windows_job;

/// Keep process-tree ownership separate from waiting for the root process.
/// Windows jobs retain descendants even after their original parent exits.
pub(crate) struct ScopedChild {
    child: Child,
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    job: windows_job::Job,
}

impl ScopedChild {
    pub(crate) fn spawn(mut command: Command) -> Result<Self, String> {
        command.kill_on_drop(true);
        #[cfg(unix)]
        {
            command.process_group(0);
            let child = command.spawn().map_err(|error| error.to_string())?;
            let pid = child.id().ok_or("Missing process id")?;
            Ok(Self { child, pid })
        }
        #[cfg(windows)]
        {
            use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            let job = windows_job::Job::new()?;
            command.creation_flags((CREATE_SUSPENDED | CREATE_NO_WINDOW).0);
            let child = command.spawn().map_err(|error| error.to_string())?;
            // No child code runs until job assignment succeeds. On any failure,
            // kill_on_drop and the owned job clean up the suspended process.
            job.assign_and_resume(&child)?;
            Ok(Self { child, job })
        }
    }

    /// Wait on the root, not the whole Windows job: a shell can leave background
    /// children alive, and those must be stopped when the shell itself finishes.
    pub(crate) fn child(&mut self) -> &mut Child {
        &mut self.child
    }

    pub(crate) async fn stop(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        let cleanup = stop_unix(self.pid, self.child.id().is_some()).await;
        #[cfg(windows)]
        let cleanup = self.job.stop().await;
        // Reap the root even if tree cleanup failed. Windows also retains the
        // kill-on-close job until this ScopedChild is dropped on every exit path.
        let _ = self.child.start_kill();
        let reaped = self
            .child
            .wait()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string());
        cleanup.and(reaped)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        net::{TcpListener, TcpStream},
        path::Path,
        time::Duration,
    };

    fn fixture(mode: &str, port_file: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "agent_execution::process_tree::tests::process_fixture",
                "--nocapture",
            ])
            .env("THUNDERBOLT_PROCESS_FIXTURE", mode)
            .env("THUNDERBOLT_PROCESS_PORT_FILE", port_file)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        command
    }

    async fn port_ready(path: &Path) -> u16 {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(path) {
                    if let Ok(port) = text.parse() {
                        return port;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture did not open its port")
    }

    async fn port_closed(port: u16) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_ok() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("descendant survived process-tree cleanup")
    }

    #[tokio::test]
    #[ignore = "subprocess fixture for Windows job ownership tests"]
    async fn process_fixture() {
        let Ok(mode) = std::env::var("THUNDERBOLT_PROCESS_FIXTURE") else {
            return;
        };
        let path =
            std::path::PathBuf::from(std::env::var_os("THUNDERBOLT_PROCESS_PORT_FILE").unwrap());
        if mode == "leaf" {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            std::fs::write(&path, listener.local_addr().unwrap().port().to_string()).unwrap();
            for stream in listener.incoming() {
                drop(stream.unwrap());
            }
            return;
        }
        if mode == "owner-exit" {
            let _owned = ScopedChild::spawn(fixture("leaf", &path)).unwrap();
            port_ready(&path).await;
            // No Rust destructors: Windows must close the owner's job handle itself.
            std::process::exit(0);
        }
        if mode == "parent-fanout" {
            let mut children = Vec::new();
            for index in 0..20 {
                let child_path = path.with_extension(index.to_string());
                children.push(fixture("leaf", &child_path).spawn().unwrap());
                port_ready(&child_path).await;
            }
            std::fs::copy(path.with_extension("0"), &path).unwrap();
            for mut child in children {
                child.wait().await.unwrap();
            }
            return;
        }
        let mut descendant = fixture("leaf", &path).spawn().unwrap();
        port_ready(&path).await;
        if mode == "parent-exit" {
            // Keep the child alive after its parent exits, without a Tokio drop killing it.
            std::process::exit(0);
        }
        descendant.wait().await.unwrap();
    }

    #[tokio::test]
    async fn windows_job_stops_descendants_before_and_after_root_exit() {
        for mode in ["parent-wait", "parent-exit"] {
            let directory = tempfile::tempdir().unwrap();
            let other_path = directory.path().join("other.port");
            let mut unrelated = ScopedChild::spawn(fixture("leaf", &other_path)).unwrap();
            let other_port = port_ready(&other_path).await;
            let path = directory.path().join("child.port");
            let mut process = ScopedChild::spawn(fixture(mode, &path)).unwrap();
            let port = port_ready(&path).await;
            if mode == "parent-exit" {
                assert!(
                    tokio::time::timeout(Duration::from_secs(5), process.child().wait())
                        .await
                        .unwrap()
                        .unwrap()
                        .success()
                );
            }
            process.stop().await.unwrap();
            // Stop must finish descendant teardown before a fixed-port restart.
            let released = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
            drop(released);
            assert!(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, other_port)).is_ok());
            unrelated.stop().await.unwrap();
        }
    }

    #[tokio::test]
    async fn windows_job_closes_on_drop_and_owner_exit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("drop.port");
        let process = ScopedChild::spawn(fixture("parent-wait", &path)).unwrap();
        let port = port_ready(&path).await;
        drop(process);
        port_closed(port).await;

        let path = directory.path().join("exit.port");
        let mut owner = fixture("owner-exit", &path).spawn().unwrap();
        let port = port_ready(&path).await;
        assert!(tokio::time::timeout(Duration::from_secs(5), owner.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
        port_closed(port).await;
    }

    #[tokio::test]
    async fn windows_job_drains_a_process_list_larger_than_the_initial_query_buffer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fanout.port");
        let mut process = ScopedChild::spawn(fixture("parent-fanout", &path)).unwrap();
        port_ready(&path).await;
        let ports: Vec<u16> = (0..20)
            .map(|index| {
                std::fs::read_to_string(path.with_extension(index.to_string()))
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect();
        process.stop().await.unwrap();
        for port in ports {
            drop(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap());
        }
    }
}

#[cfg(unix)]
fn signal(pid: i32, signal: i32) {
    // Exited processes are harmless; the child may finish between discovery and signaling.
    unsafe { libc::kill(pid, signal) };
}

#[cfg(unix)]
async fn freeze_descendants(stopped: &mut Vec<u32>) -> Result<(), String> {
    loop {
        let snapshot = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid="])
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| format!("Cannot inspect command descendants: {error}"))?;
        if !snapshot.status.success() {
            return Err("Cannot inspect command descendants".into());
        }
        let processes: Vec<(u32, u32)> = String::from_utf8(snapshot.stdout)
            .map_err(|error| error.to_string())?
            .lines()
            .map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next().and_then(|value| value.parse().ok());
                let parent = fields.next().and_then(|value| value.parse().ok());
                pid.zip(parent).ok_or("Invalid process table".to_string())
            })
            .collect::<Result<_, _>>()?;
        let before = stopped.len();
        let mut cursor = 0;
        while cursor < stopped.len() {
            for &(pid, parent) in &processes {
                if parent == stopped[cursor] && !stopped.contains(&pid) {
                    signal(pid as i32, libc::SIGSTOP);
                    stopped.push(pid);
                }
            }
            cursor += 1;
        }
        if stopped.len() == before {
            return Ok(());
        }
        // A detached child could fork before receiving SIGSTOP. Scan again after
        // freezing it, while its parents are still alive and preserve the tree.
    }
}

/// Stop live descendants before their parents can disappear from the process tree.
/// This is host cleanup, not containment of daemons that have already reparented.
#[cfg(unix)]
async fn stop_unix(pid: u32, shell_running: bool) -> Result<(), String> {
    let mut stopped = vec![pid];
    let result = if shell_running {
        signal(-(pid as i32), libc::SIGSTOP);
        tokio::time::timeout(Duration::from_secs(2), freeze_descendants(&mut stopped))
            .await
            .map_err(|_| "Timed out inspecting command descendants".to_string())
            .and_then(|result| result)
    } else {
        // wait() has reaped the shell. Its PID no longer identifies a live
        // ancestor, so only clean up the original process group.
        Ok(())
    };
    for child in stopped.into_iter().skip(1).rev() {
        signal(child as i32, libc::SIGKILL);
    }
    signal(-(pid as i32), libc::SIGKILL);
    result
}
