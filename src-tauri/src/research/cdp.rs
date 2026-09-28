//! Chrome DevTools Protocol over WebView2's in-process bridge
//! (`ICoreWebView2::CallDevToolsProtocolMethod`). No debugging port is opened, so no other
//! local process can reach the signed-in research session.
//!
//! WebView2 objects live on the UI (STA) thread: every call is marshalled there with
//! `Webview::with_webview`, and the completion handler hands the result back over a oneshot.
//! Calls on one webview are issued one at a time. A call that times out releases its turn
//! while WebView2 may still complete it; its late result is discarded (each call has its own
//! oneshot), but its effect on the page may still happen.

use std::{path::PathBuf, time::Duration};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use tauri::{Runtime, Webview};
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler,
    Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller, ICoreWebView2Environment7, ICoreWebView2_2},
};
use windows::core::{Interface, HSTRING, PWSTR};

/// Events buffered per subscription; further events are dropped until the receiver catches up.
const EVENT_BUFFER: usize = 256;

/// The WebView2 user data folder the webview actually uses. Blocks the calling thread (never
/// call it on the UI thread) until the UI thread answers.
pub fn user_data_folder<R: Runtime>(webview: &Webview<R>) -> Result<PathBuf> {
    let (sender, receiver) = std::sync::mpsc::channel::<Result<PathBuf>>();
    webview
        .with_webview(move |platform| {
            let controller: ICoreWebView2Controller = platform.controller();
            let folder = (|| -> windows::core::Result<PathBuf> {
                unsafe {
                    let environment = controller.CoreWebView2()?.cast::<ICoreWebView2_2>()?.Environment()?.cast::<ICoreWebView2Environment7>()?;
                    let mut folder = PWSTR::null();
                    environment.UserDataFolder(&mut folder)?;
                    Ok(PathBuf::from(take_pwstr(folder)))
                }
            })();
            let _ = sender.send(folder.map_err(|error| anyhow!("Could not read the WebView2 user data folder: {}", error.message())));
        })
        .context("Research webview is closed")?;
    receiver.recv_timeout(CALL_TIMEOUT).map_err(|_| anyhow!("WebView2 did not report its user data folder"))?
}

/// A DevTools event subscription. Dropping it removes the handler from the webview.
pub struct Subscription<R: Runtime> {
    receiver: tokio::sync::mpsc::Receiver<Value>,
    webview: Webview<R>,
    event: String,
    token: i64,
}

impl<R: Runtime> Subscription<R> {
    pub async fn recv(&mut self) -> Option<Value> {
        self.receiver.recv().await
    }
}

impl<R: Runtime> Drop for Subscription<R> {
    fn drop(&mut self) {
        let (event, token) = (self.event.clone(), self.token);
        let _ = self.webview.with_webview(move |platform| {
            let controller: ICoreWebView2Controller = platform.controller();
            unsafe {
                if let Ok(source) = controller.CoreWebView2().and_then(|core| core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event.as_str()))) {
                    let _ = source.remove_DevToolsProtocolEventReceived(token);
                }
            }
        });
    }
}

pub const CALL_TIMEOUT: Duration = Duration::from_secs(20);

pub struct CdpBridge<R: Runtime> {
    webview: Webview<R>,
    serial: tokio::sync::Mutex<()>,
}

impl<R: Runtime> CdpBridge<R> {
    pub fn new(webview: Webview<R>) -> Self {
        Self { webview, serial: tokio::sync::Mutex::new(()) }
    }

    pub fn webview(&self) -> &Webview<R> {
        &self.webview
    }

    /// Calls `{domain}.{method}` with JSON parameters and returns the parsed result object.
    pub async fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let _serial = self.serial.lock().await;
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String>>();
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
        let reply = sender.clone();
        let (method_name, params) = (method.to_string(), params.to_string());
        self.webview
            .with_webview(move |platform| {
                // Pins the COM type to the webview2-com version tauri-runtime-wry uses.
                let controller: ICoreWebView2Controller = platform.controller();
                let started = (|| -> windows::core::Result<()> {
                    unsafe {
                        let core = controller.CoreWebView2()?;
                        core.CallDevToolsProtocolMethod(
                            &HSTRING::from(method_name.as_str()),
                            &HSTRING::from(params.as_str()),
                            &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, json| {
                                if let Some(sender) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                                    let _ = sender.send(match status {
                                        Ok(()) => Ok(json),
                                        Err(error) => Err(anyhow!("{method_name} failed: {} {json}", error.message())),
                                    });
                                }
                                Ok(())
                            })),
                        )
                    }
                })();
                if let Err(error) = started {
                    if let Some(sender) = sender.lock().ok().and_then(|mut slot| slot.take()) {
                        let _ = sender.send(Err(anyhow!("DevTools call could not start: {}", error.message())));
                    }
                }
            })
            .context("Research webview is closed")?;
        let json = tokio::time::timeout(timeout, receiver)
            .await
            .map_err(|_| anyhow!("{method} timed out"))?
            .map_err(|_| anyhow!("{method} was abandoned"))??;
        let value: Value = serde_json::from_str(&json).with_context(|| format!("{method} returned invalid JSON"))?;
        if let Some(error) = value.get("error") {
            bail!("{method} failed: {error}");
        }
        Ok(value)
    }

    /// Delivers `event` (for example `Page.frameNavigated`) as parsed JSON parameters until the
    /// returned subscription is dropped.
    pub async fn subscribe(&self, event: &str) -> Result<Subscription<R>> {
        let (events, receiver) = tokio::sync::mpsc::channel(EVENT_BUFFER);
        let (done, registered) = tokio::sync::oneshot::channel::<Result<i64>>();
        let name = event.to_string();
        let event = event.to_string();
        self.webview
            .with_webview(move |platform| {
                let controller: ICoreWebView2Controller = platform.controller();
                let outcome = (|| -> windows::core::Result<i64> {
                    unsafe {
                        let core = controller.CoreWebView2()?;
                        let source = core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event.as_str()))?;
                        let mut token = 0i64;
                        source.add_DevToolsProtocolEventReceived(
                            &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, arguments| {
                                if let Some(arguments) = arguments {
                                    let mut json = PWSTR::null();
                                    arguments.ParameterObjectAsJson(&mut json)?;
                                    if let Ok(value) = serde_json::from_str::<Value>(&take_pwstr(json)) {
                                        let _ = events.try_send(value);
                                    }
                                }
                                Ok(())
                            })),
                            &mut token,
                        )?;
                        Ok(token)
                    }
                })();
                let _ = done.send(outcome.map_err(|error| anyhow!("Event subscription failed: {}", error.message())));
            })
            .context("Research webview is closed")?;
        let token = tokio::time::timeout(CALL_TIMEOUT, registered)
            .await
            .map_err(|_| anyhow!("Event subscription timed out"))?
            .map_err(|_| anyhow!("Event subscription was abandoned"))??;
        Ok(Subscription { receiver, webview: self.webview.clone(), event: name, token })
    }
}
