/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

/// A tab grants one agent input ticket at a time, before its command is queued.
/// Cancellation invalidates that ticket even if the command has not started yet.
#[derive(Default)]
pub(crate) struct BrowserOperations(AtomicU64);

impl BrowserOperations {
    pub(crate) fn begin(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn cancel(&self, id: u64) {
        let _ = self
            .0
            .compare_exchange(id, id.wrapping_add(1), Ordering::SeqCst, Ordering::SeqCst);
    }

    pub(crate) fn cancel_all(&self) {
        self.begin();
    }

    pub(crate) fn enter(self: &Arc<Self>, id: u64) -> Result<BrowserOperation, String> {
        let permit = InputPermit {
            operations: self.clone(),
            id,
        };
        permit.check()?;
        Ok(BrowserOperation(permit))
    }
}

#[derive(Clone)]
pub(crate) struct InputPermit {
    operations: Arc<BrowserOperations>,
    id: u64,
}

impl InputPermit {
    pub(crate) fn check(&self) -> Result<(), String> {
        if self.id == 0 || self.operations.0.load(Ordering::SeqCst) != self.id {
            return Err("Browser action was cancelled".into());
        }
        Ok(())
    }
}

pub(crate) struct BrowserOperation(InputPermit);

impl BrowserOperation {
    pub(crate) fn permit(&self) -> InputPermit {
        self.0.clone()
    }
}

impl Drop for BrowserOperation {
    fn drop(&mut self) {
        // Timed-out UI callbacks may still be queued after the async command returns.
        self.0.operations.cancel(self.0.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_command_arrival_prevents_input() {
        let operations = Arc::new(BrowserOperations::default());
        assert!(operations.enter(0).is_err());
        let id = operations.begin();
        operations.cancel(id);
        assert!(operations.enter(id).is_err());
    }

    #[test]
    fn late_cancellation_cannot_stop_a_new_action() {
        let operations = Arc::new(BrowserOperations::default());
        let previous = operations.enter(operations.begin()).unwrap();
        let current = operations.enter(operations.begin()).unwrap();
        drop(previous);
        assert!(current.permit().check().is_ok());
        let queued_callback = current.permit();
        drop(current);
        assert!(queued_callback.check().is_err());
    }

    #[tokio::test]
    async fn stopped_action_waiting_for_tab_lock_never_dispatches() {
        let operations = Arc::new(BrowserOperations::default());
        let id = operations.begin();
        let operation = operations.enter(id).unwrap();
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let held = lock.lock().await;
        let queued_lock = lock.clone();
        let (started, waiting) = tokio::sync::oneshot::channel();
        let queued = tokio::spawn(async move {
            started.send(()).unwrap();
            let _held = queued_lock.lock().await;
            operation.permit().check()
        });
        waiting.await.unwrap();
        operations.cancel(id);
        drop(held);
        assert!(queued.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn stopped_action_waiting_for_page_script_never_dispatches() {
        let operations = Arc::new(BrowserOperations::default());
        let id = operations.begin();
        let operation = operations.enter(id).unwrap();
        let (complete_script, script_result) = tokio::sync::oneshot::channel();
        let pending = tokio::spawn(async move {
            script_result.await.unwrap();
            operation.permit().check()
        });
        operations.cancel_all();
        complete_script.send(()).unwrap();
        assert!(pending.await.unwrap().is_err());
    }
}
