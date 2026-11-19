/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::time::{Duration, Instant};

const RETRY_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq)]
enum RecoveryAction {
    Reload,
    ShowRecovery,
    Stop,
}

#[derive(Default)]
struct RecoveryPolicy {
    last_termination: Option<Instant>,
    recovering: bool,
}

impl RecoveryPolicy {
    /// Allow one automatic retry, renewed only after a minute without a termination.
    fn terminated(&mut self, now: Instant) -> RecoveryAction {
        if self.recovering {
            return RecoveryAction::Stop;
        }
        let repeated = self
            .last_termination
            .is_some_and(|previous| now.duration_since(previous) < RETRY_INTERVAL);
        self.last_termination = Some(now);
        if repeated {
            self.recovering = true;
            RecoveryAction::ShowRecovery
        } else {
            RecoveryAction::Reload
        }
    }

    fn retry(&mut self) {
        *self = Self::default();
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod native {
    use super::{RecoveryAction, RecoveryPolicy};
    use std::{sync::Mutex, time::Instant};
    use tauri::{Manager, Webview};

    #[derive(Default)]
    pub struct WebviewRecovery(Mutex<RecoveryPolicy>);

    /// Replace Tauri's unconditional WebKit reload with a retry budget held outside the renderer.
    pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        builder
            .manage(WebviewRecovery::default())
            .on_web_content_process_terminate(|webview| {
                if webview.label() != "main" {
                    if let Err(error) = webview.reload() {
                        eprintln!(
                            "Could not reload terminated webview {}: {error}",
                            webview.label()
                        );
                    }
                    return;
                }

                let action = webview
                    .state::<WebviewRecovery>()
                    .0
                    .lock()
                    .unwrap()
                    .terminated(Instant::now());
                eprintln!("Thunderbolt WebKit content process terminated: {action:?}");

                let result = match action {
                    RecoveryAction::Reload => webview.reload(),
                    RecoveryAction::ShowRecovery => {
                        // A separate HTML entry avoids starting the app (and its workers) again.
                        // The main window may still be hidden if startup never finished.
                        if let Err(error) =
                            crate::commands::show_main_window(webview.app_handle().clone())
                        {
                            eprintln!("Could not show WebKit recovery: {error}");
                        }
                        navigate_to(webview, "/webview-recovery.html")
                    }
                    // Even a crash of the recovery page must not start another reload loop.
                    RecoveryAction::Stop => Ok(()),
                };
                if let Err(error) = result {
                    eprintln!("Could not recover the WebKit content process: {error}");
                }
            })
    }

    fn navigate_to(webview: &Webview, path: &str) -> tauri::Result<()> {
        let mut url = webview.url()?;
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        webview.navigate(url)
    }

    /// Explicit user retry; ordinary page loads must not replenish the crash budget.
    #[tauri::command]
    pub fn retry_webview_after_crash(webview: Webview) -> Result<(), String> {
        if webview.label() != "main" {
            return Err("Only the main webview can retry startup".into());
        }
        let state = webview.state::<WebviewRecovery>();
        state.0.lock().unwrap().retry();
        if let Err(error) = navigate_to(&webview, "/") {
            state.0.lock().unwrap().recovering = true;
            return Err(error.to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_crashes_stop_at_recovery_even_if_recovery_itself_crashes() {
        let mut policy = RecoveryPolicy::default();
        let now = Instant::now();
        assert_eq!(policy.terminated(now), RecoveryAction::Reload);
        assert_eq!(
            policy.terminated(now + Duration::from_millis(300)),
            RecoveryAction::ShowRecovery
        );
        assert_eq!(
            policy.terminated(now + Duration::from_millis(600)),
            RecoveryAction::Stop
        );
        assert_eq!(
            policy.terminated(now + RETRY_INTERVAL),
            RecoveryAction::Stop
        );
    }

    #[test]
    fn isolated_crashes_can_retry_again_after_a_stable_interval() {
        let mut policy = RecoveryPolicy::default();
        let now = Instant::now();
        assert_eq!(policy.terminated(now), RecoveryAction::Reload);
        assert_eq!(
            policy.terminated(now + RETRY_INTERVAL),
            RecoveryAction::Reload
        );
        assert_eq!(
            policy.terminated(now + RETRY_INTERVAL + Duration::from_secs(1)),
            RecoveryAction::ShowRecovery
        );
    }

    #[test]
    fn explicit_retry_has_a_fresh_but_still_bounded_budget() {
        let mut policy = RecoveryPolicy::default();
        let now = Instant::now();
        policy.terminated(now);
        policy.terminated(now);
        policy.retry();
        assert_eq!(policy.terminated(now), RecoveryAction::Reload);
        assert_eq!(policy.terminated(now), RecoveryAction::ShowRecovery);
    }
}
