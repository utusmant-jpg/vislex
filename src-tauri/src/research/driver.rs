//! The one operation every research browser action is built on: a DevTools protocol call.
//! `CdpBridge` implements it against the real webview; `FakeDriver` scripts it for tests.

use std::{future::Future, sync::Mutex};

use anyhow::Result;
use serde_json::Value;

pub trait Driver: Send + Sync {
    /// Calls `{domain}.{method}` with JSON parameters and returns the result object.
    fn call(&self, method: &str, params: Value) -> impl Future<Output = Result<Value>> + Send;
}

#[cfg(all(feature = "research", windows))]
impl<R: tauri::Runtime> Driver for super::cdp::CdpBridge<R> {
    fn call(&self, method: &str, params: Value) -> impl Future<Output = Result<Value>> + Send {
        super::cdp::CdpBridge::call(self, method, params, super::cdp::CALL_TIMEOUT)
    }
}

type Responder = Box<dyn Fn(&str, &Value) -> Result<Value> + Send + Sync>;

/// Test driver: answers each call from a closure and records every call made.
pub struct FakeDriver {
    responder: Responder,
    calls: Mutex<Vec<(String, Value)>>,
}

impl FakeDriver {
    pub fn new(responder: impl Fn(&str, &Value) -> Result<Value> + Send + Sync + 'static) -> Self {
        Self { responder: Box::new(responder), calls: Mutex::new(Vec::new()) }
    }

    pub fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub fn methods(&self) -> Vec<String> {
        self.calls().into_iter().map(|(method, _)| method).collect()
    }
}

impl Driver for FakeDriver {
    fn call(&self, method: &str, params: Value) -> impl Future<Output = Result<Value>> + Send {
        self.calls.lock().unwrap_or_else(|error| error.into_inner()).push((method.to_string(), params.clone()));
        let result = (self.responder)(method, &params);
        async move { result }
    }
}
