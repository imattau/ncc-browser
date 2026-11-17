//! Approval prompts for signer requests.
//!
//! A page asking for a signature must not block a relay query, so each request parks
//! on a one-shot channel and the shell is told about it out of band. Whatever the
//! shell answers — or a timeout — resolves that request and nothing else.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;

/// What the shell needs to render a prompt. Deliberately small: a page can put
/// anything in an event, so the preview is the only free text.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub id: String,
    /// `npub/service`, the unit trust is granted to.
    pub service: String,
    pub method: String,
    pub kind: Option<u16>,
    pub preview: String,
    /// Signing with a throwaway key: there is nothing worth remembering a choice for.
    #[serde(default)]
    pub ephemeral: bool,
}

type Notify = Box<dyn Fn(ApprovalRequest) + Send + Sync>;

pub struct Approvals {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    notify: Notify,
    counter: AtomicU64,
}

impl Approvals {
    pub fn new(notify: impl Fn(ApprovalRequest) + Send + Sync + 'static) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            notify: Box::new(notify),
            counter: AtomicU64::new(1),
        }
    }

    /// Park a request and wait for an answer. `false` on timeout, which is the safe
    /// direction: a prompt nobody answered is not consent.
    pub async fn ask(&self, mut request: ApprovalRequest, timeout: Duration) -> bool {
        request.id = format!("req-{}", self.counter.fetch_add(1, Ordering::Relaxed));

        let (sender, receiver) = oneshot::channel();
        crate::lock(&self.pending).insert(request.id.clone(), sender);

        (self.notify)(request.clone());

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(allowed)) => allowed,
            _ => {
                crate::lock(&self.pending).remove(&request.id);
                false
            }
        }
    }

    /// Answer a parked request. False when the id is unknown or already answered.
    pub fn resolve(&self, id: &str, allow: bool) -> bool {
        match crate::lock(&self.pending).remove(id) {
            Some(sender) => sender.send(allow).is_ok(),
            None => false,
        }
    }

    /// How many prompts are waiting; the shell uses it to know whether to show itself.
    pub fn pending(&self) -> usize {
        crate::lock(&self.pending).len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;

    fn request() -> ApprovalRequest {
        ApprovalRequest {
            id: String::new(),
            service: "npub1x/web".into(),
            method: "sign-event".into(),
            kind: Some(1),
            preview: "hello".into(),
            ephemeral: false,
        }
    }

    #[tokio::test]
    async fn an_approval_resolves_the_waiting_request() {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let broker = Arc::new(Approvals::new(move |request| {
            recorder.lock().unwrap().push(request.id.clone());
        }));

        let answering = broker.clone();
        let poll = seen.clone();
        tokio::spawn(async move {
            for _ in 0..200 {
                let id = { poll.lock().unwrap().first().cloned() };
                if let Some(id) = id {
                    answering.resolve(&id, true);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });

        assert!(broker.ask(request(), Duration::from_secs(2)).await);
        assert_eq!(broker.pending(), 0);
    }

    #[tokio::test]
    async fn an_unanswered_prompt_times_out_to_no() {
        let broker = Approvals::new(|_| {});
        assert!(!broker.ask(request(), Duration::from_millis(50)).await);
        assert_eq!(broker.pending(), 0);
    }

    #[tokio::test]
    async fn resolving_an_unknown_id_is_reported() {
        let broker = Approvals::new(|_| {});
        assert!(!broker.resolve("nope", true));
    }
}
