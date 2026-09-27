//! Subscription-backed case turns. App Server receives no case filesystem path:
//! every operation crosses the host's existing grant-checked agent tool path.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, time::{Duration, Instant}};

fn dynamic_tools(definitions: &[Value]) -> Result<Value> {
    let mut names = std::collections::HashSet::new();
    let mut tools = Vec::new();
    for definition in definitions {
        let name = definition["name"].as_str().context("Case tool is missing a name")?;
        ensure!(names.insert(name), "Duplicate case tool");
        tools.push(json!({"type":"function","name":name,
            "description":definition["description"],"inputSchema":definition["parameters"]}));
    }
    ensure!(!tools.is_empty(), "No case tools are available");
    Ok(json!([{"type":"namespace","name":"vislex",
        "description":"Grant-checked VisLex case actions with revisioned receipts and human review gates",
        "tools":tools}]))
}

pub fn run(
    directory: &Path,
    model: &str,
    effort: &str,
    instructions: &str,
    definitions: &[Value],
    context: &str,
    mut on_tool: impl FnMut(&str, &str, Value) -> Result<Value>,
    mut on_progress: impl FnMut(&str),
    mut cancelled: impl FnMut() -> bool,
) -> Result<(Option<String>, Option<Value>)> {
    ensure!(crate::providers::validate_model(model).is_ok(),"Invalid Codex model");
    ensure!(matches!(effort,"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"|"ultra"),"Invalid Codex effort");
    let mut connection = crate::codex_account::Connection::start_case(directory)?;
    let tools = dynamic_tools(definitions)?;
    let cwd = connection.home().to_string_lossy().to_string();
    let thread = connection.call("thread/start",json!({"model":model,"cwd":cwd,
        "ephemeral":true,"baseInstructions":instructions,"dynamicTools":tools}))?;
    let thread_id = thread["thread"]["id"].as_str().context("Codex thread ID missing")?.to_owned();
    let started = connection.call("turn/start",json!({"threadId":thread_id,
        "input":[{"type":"text","text":context}],"model":model,"effort":effort}))?;
    let turn_id = started["turn"]["id"].as_str().context("Codex turn ID missing")?.to_owned();
    let mut last_message = None;
    let mut usage = None;
    let mut last_event = Instant::now();
    loop {
        if cancelled() {
            let _ = connection.send(json!({"id":u64::MAX,"method":"turn/interrupt",
                "params":{"threadId":thread_id,"turnId":turn_id}}));
            bail!("Codex task cancelled");
        }
        ensure!(last_event.elapsed() < Duration::from_secs(15*60),"Codex turn made no progress for fifteen minutes");
        let Some(event) = connection.next_message(Duration::from_millis(250))? else { continue; };
        last_event = Instant::now();
        let method = event["method"].as_str().unwrap_or("");
        let params = &event["params"];
        match method {
            "item/tool/call" => {
                let request_id = event.get("id").cloned().context("Codex tool request ID missing")?;
                let result = (|| -> Result<Value> {
                    ensure!(params["threadId"] == thread_id && params["turnId"] == turn_id,
                        "Codex tool request belongs to a different turn");
                    ensure!(params["namespace"] == "vislex","Unexpected Codex tool namespace");
                    let call_id = params["callId"].as_str().context("Codex call ID missing")?;
                    let name = params["tool"].as_str().context("Codex tool name missing")?;
                    on_tool(call_id,name,params["arguments"].clone())
                })();
                let response = match result {
                    Ok(response) => response,
                    Err(error) => json!({"contentItems":[{"type":"inputText",
                        "text":format!("VisLex action failed: {}",error.to_string().chars().take(400).collect::<String>())}],"success":false}),
                };
                connection.send(json!({"id":request_id,"result":response}))?;
            }
            "item/agentMessage/delta" if params["threadId"] == thread_id && params["turnId"] == turn_id => {
                if let Some(delta) = params["delta"].as_str() { on_progress(delta); }
            }
            "item/completed" if params["threadId"] == thread_id && params["turnId"] == turn_id => {
                if params["item"]["type"] == "agentMessage" {
                    if let Some(text) = params["item"]["text"].as_str() { last_message = Some(text.to_owned()); }
                }
            }
            "thread/tokenUsage/updated" if params["threadId"] == thread_id && params["turnId"] == turn_id => {
                let total=&params["tokenUsage"]["total"];
                usage=Some(json!({"input_tokens":total["inputTokens"],"output_tokens":total["outputTokens"],
                    "cached_input_tokens":total["cachedInputTokens"],"reasoning_output_tokens":total["reasoningOutputTokens"]}));
            }
            "turn/completed" if params["threadId"] == thread_id && params["turn"]["id"] == turn_id => {
                ensure!(params["turn"]["status"] == "completed", "Codex turn did not complete: {}", params["turn"]["status"]);
                if last_message.is_none() {
                    last_message=params["turn"]["items"].as_array().and_then(|items|items.iter().rev().find(|item|item["type"]=="agentMessage"))
                        .and_then(|item|item["text"].as_str()).map(str::to_owned);
                }
                return Ok((last_message,usage));
            }
            _ => {
                // Unknown server requests receive an explicit error. Notifications
                // outside this turn carry no case authority and are ignored.
                if event.get("id").is_some() && event.get("method").is_some() {
                    connection.send(json!({"id":event["id"],"error":{"code":-32601,"message":"Method unavailable in VisLex"}}))?;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_case_tools_are_advertised() {
        let definitions=vec![json!({"name":"read_text","description":"Read a permitted source","parameters":{"type":"object","properties":{},"additionalProperties":false}})];
        let value=dynamic_tools(&definitions).unwrap();
        assert_eq!(value[0]["name"],"vislex");
        assert_eq!(value[0]["tools"][0]["name"],"read_text");
        assert_eq!(value[0]["tools"].as_array().unwrap().len(),1);
    }

    #[test]
    #[ignore = "Requires the patched Windows App Server; no login or model call is made"]
    fn patched_server_accepts_ephemeral_case_tool_policy() -> Result<()> {
        let binary = std::env::var_os("VISLEX_CODEX_BINARY").context("Set VISLEX_CODEX_BINARY")?;
        let directory = Path::new(&binary).parent().context("Codex binary has no directory")?;
        let mut connection = crate::codex_account::Connection::start_case(directory)?;
        let tools = dynamic_tools(&[json!({"name":"read_text","description":"Read a permitted source",
            "parameters":{"type":"object","properties":{},"additionalProperties":false}})])?;
        let started = connection.call("thread/start",json!({"cwd":connection.home(),"ephemeral":true,
            "baseInstructions":"Synthetic tool schema probe; no case data or model turn", "dynamicTools":tools}))?;
        ensure!(started["thread"]["id"].as_str().is_some(),"Ephemeral thread ID missing");
        Ok(())
    }
}
