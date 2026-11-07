/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::time::Duration;
use tokio::process::Command;

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
pub(super) async fn stop(pid: u32, shell_running: bool) -> Result<(), String> {
    #[cfg(unix)]
    {
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
    #[cfg(windows)]
    {
        if !shell_running {
            return Ok(());
        }
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .kill_on_drop(true)
            .output();
        tokio::time::timeout(Duration::from_secs(2), output)
            .await
            .map_err(|_| "Timed out stopping command descendants".to_string())?
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
