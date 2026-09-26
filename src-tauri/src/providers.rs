//! Provider adapters. The coordinator, not a hosted agent runtime, owns tool execution.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    #[default]
    Openai,
    Anthropic,
    Gemini,
    Xai,
}
impl Provider {
    pub fn credential(self) -> &'static str {
        match self {
            Self::Openai => "openai-api-key",
            Self::Anthropic => "anthropic-api-key",
            Self::Gemini => "gemini-api-key",
            Self::Xai => "xai-api-key",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Gemini => "Gemini",
            Self::Xai => "xAI",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub provider: Provider,
    pub model: String,
    #[serde(default)]
    pub allow_text: bool,
    #[serde(default)]
    pub allow_images: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Execution {
    #[default]
    Single,
    Parallel,
    Auto,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Review {
    #[default]
    Standard,
    Independent,
    Challenge,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub provider: Provider,
    pub execution: Execution,
    pub review: Review,
    pub pool: Vec<Profile>,
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.pool.len() <= 16,
            "Configure at most sixteen provider/model profiles"
        );
        let mut seen = std::collections::HashSet::new();
        for p in &self.pool {
            validate_model(&p.model)?;
            ensure!(
                seen.insert((p.provider.credential(), p.model.clone())),
                "Duplicate provider/model profile"
            );
            ensure!(
                !p.allow_images || p.allow_text,
                "Image permission requires text permission"
            );
        }
        Ok(())
    }
}
pub fn validate_model(model: &str) -> Result<()> {
    ensure!(
        !model.trim().is_empty()
            && model.len() <= 120
            && model
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._:/".contains(c)),
        "Invalid model identifier"
    );
    Ok(())
}
pub fn load(case: &crate::case::Case) -> Result<Config> {
    Ok(case
        .meta("ai_config")?
        .map(|v| serde_json::from_str(&v))
        .transpose()?
        .unwrap_or_default())
}
pub fn save(case: &mut crate::case::Case, config: Config) -> Result<()> {
    config.validate()?;
    ensure!(
        case.db.query_row(
            "SELECT count(*) FROM tasks WHERE status='running'",
            [],
            |r| r.get::<_, i64>(0)
        )? == 0,
        "Stop the active investigation before changing provider routing"
    );
    let changed_provider = load(case)?.provider != config.provider;
    case.db.execute_batch("SAVEPOINT provider_config")?;
    let result = (|| -> Result<()> {
        if changed_provider {
            let mut settings = case.settings()?;
            settings.allow_text = false;
            settings.allow_images = false;
            case.save_settings(settings)?;
        }
        case.set_meta("ai_config", &serde_json::to_string(&config)?)?;
        case.audit("ai_configuration_changed", serde_json::to_value(config)?)
    })();
    if let Err(e) = result {
        case.db
            .execute_batch("ROLLBACK TO provider_config; RELEASE provider_config")?;
        return Err(e);
    }
    case.db.execute_batch("RELEASE provider_config")?;
    Ok(())
}
pub fn task_profile(case: &crate::case::Case, task: &str) -> Result<Profile> {
    if let Some(v) = case.meta(&format!("task_profile:{task}"))? {
        return Ok(serde_json::from_str(&v)?);
    }
    let s = case.settings()?;
    Ok(Profile {
        provider: load(case)?.provider,
        model: s.model,
        allow_text: s.allow_text,
        allow_images: s.allow_images,
    })
}
pub fn check_permission(case: &crate::case::Case, p: &Profile) -> Result<()> {
    let s = case.settings()?;
    ensure!(
        !s.offline && s.allow_text && p.allow_text,
        "Text transmission is disabled"
    );
    // The durable case-level image grant gates every profile; provider/model
    // routing and pool grants cannot silently expand it.
    ensure!(
        !p.allow_images || s.allow_images,
        "Image transmission is disabled for this case"
    );
    let c = load(case)?;
    if p.provider != c.provider || p.model != s.model {
        ensure!(
            c.pool
                .iter()
                .any(|x| x.provider == p.provider && x.model == p.model && x.allow_text),
            "Provider profile is no longer approved"
        );
        if p.allow_images {
            ensure!(
                c.pool
                    .iter()
                    .any(|x| x.provider == p.provider && x.model == p.model && x.allow_images),
                "Provider image permission is no longer approved"
            );
        }
    }
    Ok(())
}

pub struct WireRequest {
    pub url: String,
    pub body: Value,
}
fn image_data(url: &str) -> Result<(&str, &str)> {
    let (mime, data) = url
        .strip_prefix("data:")
        .context("Only source-linked inline images are supported")?
        .split_once(";base64,")
        .context("Invalid image data")?;
    ensure!(
        ["image/jpeg", "image/png", "image/webp"].contains(&mime),
        "Unsupported image type"
    );
    Ok((mime, data))
}
/// Translate our persisted Responses-shaped tool transcript without flattening tool results into prose.
pub fn encode(provider: Provider, body: &Value) -> Result<WireRequest> {
    let model = body["model"].as_str().context("Missing model")?;
    validate_model(model)?;
    if matches!(provider, Provider::Openai | Provider::Xai) {
        ensure!(!body["input"].as_array().into_iter().flatten().flat_map(|i|i["content"].as_array().into_iter().flatten()).any(|p|p["type"]=="input_media"),"Direct media is supported only by Gemini");
        let mut request = body.clone();
        if let Some(input) = request["input"].as_array_mut() {
            input.retain(|v| v["type"] != "provider_native");
            for v in input {
                if let Some(o) = v.as_object_mut() {
                    o.remove("native_part");
                }
            }
        }
        if provider == Provider::Xai {
            request.as_object_mut().unwrap().remove("reasoning");
        }
        return Ok(WireRequest {
            url: match provider {
                Provider::Xai => "https://api.x.ai/v1/responses",
                _ => "https://api.openai.com/v1/responses",
            }
            .into(),
            body: request,
        });
    }
    let mut messages: Vec<Value> = Vec::new();
    let mut names = std::collections::HashMap::<String, String>::new();
    for item in body["input"].as_array().context("Missing input")? {
        let kind = item["type"].as_str().unwrap_or("message");
        let (role, parts) = match kind {
            "reasoning" => continue,
            "provider_native" => {
                if item["provider"] == serde_json::to_value(provider)? {
                    ("assistant", vec![item["part"].clone()])
                } else {
                    continue;
                }
            }
            "function_call" => {
                let cid = item["call_id"].as_str().context("Missing call ID")?;
                let name = item["name"].as_str().context("Missing tool name")?;
                names.insert(cid.into(), name.into());
                let args: Value = serde_json::from_str(
                    item["arguments"]
                        .as_str()
                        .context("Missing tool arguments")?,
                )?;
                let part = if provider == Provider::Anthropic {
                    json!({"type":"tool_use","id":cid,"name":name,"input":args})
                } else if item["native_part"].is_object() {
                    item["native_part"].clone()
                } else {
                    json!({"functionCall":{"id":cid,"name":name,"args":args}})
                };
                ("assistant", vec![part])
            }
            "function_call_output" => {
                let cid = item["call_id"].as_str().context("Missing result call ID")?;
                let name = names
                    .get(cid)
                    .context("Orphaned tool result; restore its original call before dispatch")?;
                let value = item["output"].as_str().unwrap_or("");
                let part = if provider == Provider::Anthropic {
                    json!({"type":"tool_result","tool_use_id":cid,"content":value})
                } else {
                    json!({"functionResponse":{"id":cid,"name":name,"response":{"result":value}}})
                };
                ("user", vec![part])
            }
            "message" if provider == Provider::Gemini && item["role"] == "assistant" && item["native_part"].is_object() => {
                ("assistant", vec![item["native_part"].clone()])
            }
            _ => {
                let mut parts = Vec::new();
                if let Some(s) = item["content"].as_str() {
                    if !s.is_empty() {
                        parts.push(if provider == Provider::Anthropic {
                            json!({"type":"text","text":s})
                        } else {
                            json!({"text":s})
                        });
                    }
                } else if let Some(items) = item["content"].as_array() {
                    for part in items {
                        if let Some(t) = part["text"].as_str() {
                            parts.push(if provider == Provider::Anthropic {
                                json!({"type":"text","text":t})
                            } else {
                                json!({"text":t})
                            });
                        } else if part["type"]=="input_media" {
                            ensure!(provider==Provider::Gemini,"Direct media is supported only by the Gemini adapter");
                            let mime=part["mime_type"].as_str().context("Missing media type")?;
                            ensure!(["video/mp4","video/webm","audio/wav","audio/x-wav","audio/mpeg","audio/mp4","audio/flac","audio/ogg"].contains(&mime),"Unsupported direct media type");
                            let data=part["data"].as_str().context("Missing media payload")?;
                            ensure!(data.len()<=16*1024*1024,"Direct media payload too large");
                            parts.push(json!({"inlineData":{"mimeType":mime,"data":data}}));
                        } else if let Some(url) = part["image_url"].as_str() {
                            let (mime, data) = image_data(url)?;
                            parts.push(if provider==Provider::Anthropic{json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})}else{json!({"inlineData":{"mimeType":mime,"data":data}})});
                        }
                    }
                }
                (
                    if item["role"] == "assistant" {
                        "assistant"
                    } else {
                        "user"
                    },
                    parts,
                )
            }
        };
        if parts.is_empty() {
            continue;
        }
        let wire_role = if provider == Provider::Gemini && role == "assistant" {
            "model"
        } else {
            role
        };
        let field = if provider == Provider::Anthropic {
            "content"
        } else {
            "parts"
        };
        if messages.last().is_some_and(|m| m["role"] == wire_role) {
            messages.last_mut().unwrap()[field]
                .as_array_mut()
                .unwrap()
                .extend(parts);
        } else {
            let mut m = json!({"role":wire_role});
            m[field] = json!(parts);
            messages.push(m);
        }
    }
    let defs = body["tools"].as_array().cloned().unwrap_or_default();
    let forced = body["tool_choice"]["name"].as_str();
    let request = if provider == Provider::Anthropic {
        let tools:Vec<_>=defs.iter().map(|t|json!({"name":t["name"],"description":t["description"],"input_schema":t["parameters"]})).collect();
        let mut value = json!({"model":model,"max_tokens":body["max_output_tokens"],"system":body["instructions"],"messages":messages,"tools":tools,"stream":true});
        value["tool_choice"] = if let Some(name) = forced {
            json!({"type":"tool","name":name,"disable_parallel_tool_use":true})
        } else {
            json!({"type":"auto","disable_parallel_tool_use":true})
        };
        value
    } else {
        let tools:Vec<_>=defs.iter().map(|t|json!({"name":t["name"],"description":t["description"],"parametersJsonSchema":t["parameters"]})).collect();
        let mut value = json!({"systemInstruction":{"parts":[{"text":body["instructions"]}]},"contents":messages,"tools":[{"functionDeclarations":tools}],"generationConfig":{"maxOutputTokens":body["max_output_tokens"]}});
        if let Some(name) = forced {
            value["toolConfig"] =
                json!({"functionCallingConfig":{"mode":"ANY","allowedFunctionNames":[name]}});
        }
        value
    };
    let url = if provider == Provider::Anthropic {
        "https://api.anthropic.com/v1/messages".into()
    } else {
        ensure!(
            model
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c)),
            "Gemini requires a model ID without a path"
        );
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")
    };
    Ok(WireRequest { url, body: request })
}

pub fn decode(provider: Provider, response: Value) -> Result<Value> {
    if matches!(provider, Provider::Openai | Provider::Xai) {
        return Ok(response);
    }
    let mut output = Vec::new();
    if provider == Provider::Anthropic {
        match response["stop_reason"].as_str() {
            Some("end_turn" | "tool_use") => {},
            Some("max_tokens") => bail!("Claude response incomplete: output token limit reached"),
            Some("model_context_window_exceeded") => bail!("Claude response incomplete: context window exceeded"),
            Some("refusal") => bail!("Claude refused the response"),
            Some("pause_turn") => bail!("Claude paused before completing the response"),
            _ => bail!("Claude did not complete the response"),
        }
        for part in response["content"]
            .as_array()
            .context("Missing Claude content")?
        {
            match part["type"].as_str().unwrap_or("") {
                "text"=>output.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":part["text"]}]})),
                "tool_use"=>output.push(json!({"type":"function_call","call_id":part["id"],"name":part["name"],"arguments":part["input"].to_string()})),
                "thinking"|"redacted_thinking"=>output.push(json!({"type":"provider_native","provider":"anthropic","part":part})),
                _=>{}
            }
        }
        return Ok(json!({"status":"completed","output":output,"usage":response["usage"]}));
    }
    let candidate = &response["candidates"][0];
    match candidate["finishReason"].as_str() {
        Some("STOP") => {},
        Some("MAX_TOKENS") => bail!("Gemini response incomplete: output token limit reached"),
        Some("SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" | "LANGUAGE") => bail!("Gemini response blocked by provider policy"),
        Some("MALFORMED_FUNCTION_CALL") => bail!("Gemini returned a malformed function call"),
        _ if response["promptFeedback"]["blockReason"].as_str().is_some_and(|reason| ["SAFETY","BLOCKLIST","PROHIBITED_CONTENT","IMAGE_SAFETY"].contains(&reason)) => bail!("Gemini prompt blocked by provider policy"),
        _ => bail!("Gemini did not complete the response"),
    }
    for part in candidate["content"]["parts"]
        .as_array()
        .context("Missing Gemini content")?
    {
        if part["functionCall"].is_object() {
            let call = &part["functionCall"];
            let cid = call["id"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(crate::case::id);
            let mut native = part.clone();
            native["functionCall"]["id"] = json!(cid);
            output.push(json!({"type":"function_call","call_id":cid,"name":call["name"],"arguments":call["args"].to_string(),"native_part":native}));
        } else if part["thought"] == true {
            output.push(json!({"type":"provider_native","provider":"gemini","part":part}));
        } else if part["text"].is_string() {
            output.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":part["text"]}],"native_part":part}));
        } else if part["thoughtSignature"].is_string() {
            output.push(json!({"type":"provider_native","provider":"gemini","part":part}));
        }
    }
    Ok(
        json!({"status":"completed","output":output,"usage":{"input_tokens":response["usageMetadata"]["promptTokenCount"],"output_tokens":response["usageMetadata"]["candidatesTokenCount"],"reasoning_tokens":response["usageMetadata"]["thoughtsTokenCount"]}}),
    )
}

/// Extract the provider's own bounded rejection reason from a 4xx/5xx body.
/// Error bodies carry account, quota and schema diagnostics — never evidence
/// content — so surfacing the parsed message keeps failures diagnosable
/// without logging a successful response body.
async fn provider_rejection(response: &mut reqwest::Response) -> String {
    let mut bytes = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        bytes.extend_from_slice(&chunk);
        if bytes.len() >= 64 * 1024 {
            break;
        }
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let message = value["error"]["message"]
        .as_str()
        .or_else(|| value["error"].as_str())
        .or_else(|| value["message"].as_str())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(|m| {
            let mut detail = m.chars().take(400).collect::<String>();
            if m.chars().count() > 400 {
                detail.push('…');
            }
            format!("Provider says: {detail}")
        })
        .unwrap_or_else(|| "Provider supplied no readable error detail.".into());
    format!("Check model, credentials, permissions and quota. {message}")
}

pub fn synthetic_provider_url() -> Result<Option<String>> {
    #[cfg(debug_assertions)]
    {
        if std::env::var("VISLEX_TEST_MODE").as_deref() == Ok("1") {
            if let Ok(raw) = std::env::var("VISLEX_TEST_PROVIDER_URL") {
                let url = reqwest::Url::parse(&raw)?;
                ensure!(url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "::1")), "Synthetic provider endpoint must be loopback HTTP");
                return Ok(Some(raw));
            }
        }
    }
    Ok(None)
}

/// Assemble Claude's SSE blocks without treating partial tool JSON as a call.
#[derive(Default)]
pub struct ClaudeStream {
    message: Option<Value>,
    blocks: std::collections::BTreeMap<usize, Value>,
    open: std::collections::BTreeSet<usize>,
    tool_json: std::collections::BTreeMap<usize, String>,
}
impl ClaudeStream {
    pub fn push(&mut self, event: &Value) -> Result<Option<Value>> {
        match event["type"].as_str().context("Missing Claude stream event type")? {
            "ping" => {},
            "message_start" => {
                ensure!(self.message.is_none(), "Duplicate Claude message start");
                let message = event["message"].as_object().context("Missing Claude message")?;
                self.message = Some(Value::Object(message.clone()));
            },
            "content_block_start" => {
                ensure!(self.message.is_some(), "Claude content before message start");
                let index = event["index"].as_u64().context("Missing Claude block index")? as usize;
                ensure!(index < 1000 && !self.blocks.contains_key(&index), "Duplicate or excessive Claude content block");
                ensure!(event["content_block"].is_object(), "Missing Claude content block");
                self.blocks.insert(index, event["content_block"].clone());
                self.open.insert(index);
            },
            "content_block_delta" => {
                let index = event["index"].as_u64().context("Missing Claude block index")? as usize;
                ensure!(self.open.contains(&index), "Claude delta outside an open block");
                let block = self.blocks.get_mut(&index).context("Missing Claude block")?;
                let delta = &event["delta"];
                match delta["type"].as_str().context("Missing Claude delta type")? {
                    "text_delta" if block["type"] == "text" => {
                        block["text"].as_str().context("Missing Claude text")?;
                        let text = delta["text"].as_str().context("Missing Claude text delta")?;
                        block["text"] = json!(format!("{}{text}", block["text"].as_str().unwrap_or("")));
                    },
                    "input_json_delta" if block["type"] == "tool_use" => {
                        let fragment = delta["partial_json"].as_str().context("Missing Claude tool delta")?;
                        if !fragment.is_empty() { self.tool_json.entry(index).or_default().push_str(fragment); }
                    },
                    "thinking_delta" if block["type"] == "thinking" => {
                        let text = delta["thinking"].as_str().context("Missing Claude thought delta")?;
                        block["thinking"] = json!(format!("{}{text}", block["thinking"].as_str().unwrap_or("")));
                    },
                    "signature_delta" if block["type"] == "thinking" => {
                        block["signature"] = delta["signature"].clone();
                    },
                    _ => anyhow::bail!("Unsupported Claude stream delta"),
                }
            },
            "content_block_stop" => {
                let index = event["index"].as_u64().context("Missing Claude block index")? as usize;
                ensure!(self.open.remove(&index), "Claude block stop without an open block");
                if let Some(args) = self.tool_json.remove(&index) {
                    self.blocks.get_mut(&index).context("Missing Claude tool block")?["input"] = serde_json::from_str(&args).context("Malformed Claude tool arguments")?;
                }
            },
            "message_delta" => {
                let message = self.message.as_mut().context("Claude message delta before start")?;
                if !event["delta"]["stop_reason"].is_null() { message["stop_reason"] = event["delta"]["stop_reason"].clone(); }
                if !event["usage"].is_null() {
                    let usage = event["usage"].as_object().context("Invalid Claude usage")?;
                    for (key, value) in usage { message["usage"][key] = value.clone(); }
                }
            },
            "message_stop" => {
                ensure!(self.open.is_empty(), "Claude message ended with an open content block");
                let mut message = self.message.take().context("Claude message stop before start")?;
                ensure!(self.blocks.keys().enumerate().all(|(expected, actual)| expected == *actual), "Claude content block gap");
                message["content"] = json!(std::mem::take(&mut self.blocks).into_values().collect::<Vec<_>>());
                return Ok(Some(decode(Provider::Anthropic, message)?));
            },
            "error" => anyhow::bail!("Claude stream error: {}", stream_failure_detail(event)),
            _ => anyhow::bail!("Unsupported Claude stream event"),
        }
        Ok(None)
    }
}

fn inference_client() -> Result<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() { return Ok(client.clone()); }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(300))
        .build()?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

fn catalogue_client() -> Result<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() { return Ok(client.clone()); }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

pub async fn send(
    provider: Provider,
    key: &str,
    body: Value,
    mut progress: impl FnMut(Value),
) -> Result<Value> {
    let mut wire = encode(provider, &body)?;
    // The packaged debug acceptance harness may replace the network endpoint
    // with a loopback server. Release builds have no endpoint override.
    if let Some(url) = synthetic_provider_url()? { wire.url = url; }
    let client = inference_client()?;
    let request = client.post(&wire.url).json(&wire.body);
    let request = match provider {
        Provider::Anthropic => request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        Provider::Gemini => request.header("x-goog-api-key", key),
        _ => request.bearer_auth(key),
    };
    let mut response = request.send().await?;
    if !response.status().is_success() {
        let detail = provider_rejection(&mut response).await;
        bail!(
            "{} returned HTTP {}. {}",
            provider.name(),
            response.status().as_u16(),
            detail
        );
    }
    if provider == Provider::Gemini {
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 32 * 1024 * 1024,
                "Provider response exceeded size limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        let value = decode(provider, serde_json::from_slice(&bytes)?)?;
        progress(json!({"activity":"Provider response received; validating evidence tools"}));
        return Ok(value);
    }
    let mut stream = crate::agent::ResponseStream::default();
    let mut claude = ClaudeStream::default();
    while let Some(chunk) = response.chunk().await? {
        for event in stream.push(&chunk)? {
            if provider == Provider::Anthropic {
                if let Some(value) = claude.push(&event)? { return Ok(value); }
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                    progress(json!({"text":event["delta"]["text"]}));
                }
                continue;
            }
            match event["type"].as_str().unwrap_or("") {
                "response.completed" => return Ok(event["response"].clone()),
                "response.failed" | "response.incomplete" | "error" => {
                    bail!("Provider stopped before completing the response: {}", stream_failure_detail(&event))
                }
                "response.output_text.delta" => progress(json!({"text":event["delta"]})),
                "response.output_item.added" if event["item"]["type"] == "function_call" => {
                    progress(json!({"activity":event["item"]["name"]}))
                }
                "response.function_call_arguments.delta" => progress(
                    json!({"characters":event["delta"].as_str().map(str::len).unwrap_or(0)}),
                ),
                _ => {}
            }
        }
    }
    bail!("Provider stream ended without completion; no final result published")
}

/// Provider stream errors may contain arbitrary text. Only known completion
/// reasons and a bounded provider error message are suitable for the UI.
pub fn stream_failure_detail(event: &Value) -> String {
    let reason = event["response"]["incomplete_details"]["reason"]
        .as_str()
        .filter(|reason| ["max_output_tokens", "content_filter", "max_context_length"].contains(reason));
    if let Some(reason) = reason { return format!("Incomplete response: {reason}"); }
    let message = event["response"]["error"]["message"]
        .as_str()
        .or_else(|| event["error"]["message"].as_str())
        .or_else(|| event["message"].as_str())
        .unwrap_or("no provider detail supplied");
    message.chars().take(400).collect()
}

/// Resolve only explicitly approved models; callers cannot elevate modality permissions.
pub fn select_profile(case: &crate::case::Case, provider: Provider, model: &str) -> Result<Profile> {
    let settings = case.settings()?;
    let config = load(case)?;
    let profile = if provider == config.provider && model == settings.model {
        Profile { provider, model: model.into(), allow_text: settings.allow_text, allow_images: settings.allow_images }
    } else {
        config.pool.into_iter().find(|p| p.provider == provider && p.model == model)
            .context("Enable this provider/model in AI settings first")?
    };
    validate_model(&profile.model)?;
    check_permission(case, &profile)?;
    Ok(profile)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOption { pub id: String, pub name: String }
/// Catalogue membership is not a tool/modality capability certification.
pub fn model_options(provider: Provider, value: &Value) -> Result<Vec<ModelOption>> {
    let rows=value[if provider==Provider::Gemini {"models"} else {"data"}].as_array().context("Provider returned an invalid model catalogue")?;
    let mut result=Vec::new();
    for row in rows {
        let id=row[if provider==Provider::Gemini {"name"} else {"id"}].as_str().unwrap_or("").trim_start_matches("models/");
        if validate_model(id).is_err() {continue;}
        let lower=id.to_ascii_lowercase();
        let candidate=match provider {
            Provider::Openai => (lower.starts_with("gpt-") || lower.starts_with("chatgpt-") || lower.starts_with("o1") || lower.starts_with("o3") || lower.starts_with("o4") || lower.starts_with("ft:gpt-")) && !["audio","realtime","transcribe","image","search","instruct"].iter().any(|part|lower.contains(part)),
            Provider::Anthropic => lower.starts_with("claude-"),
            Provider::Gemini => row["supportedGenerationMethods"].as_array().is_some_and(|methods|methods.iter().any(|m|m=="generateContent")) && !["tts","image","robotics"].iter().any(|part|lower.contains(part)),
            Provider::Xai => lower.starts_with("grok-") && !["image","video","imagine"].iter().any(|part|lower.contains(part)),
        };
        if candidate {result.push(ModelOption{id:id.into(),name:row[if provider==Provider::Gemini {"displayName"} else {"display_name"}].as_str().unwrap_or(id).into()});}
    }
    result.sort_by(|a,b|a.id.cmp(&b.id));result.dedup_by(|a,b|a.id==b.id);Ok(result)
}
pub async fn list_models(provider: Provider, key: &str) -> Result<Vec<ModelOption>> {
    let url=match provider {
        Provider::Openai=>"https://api.openai.com/v1/models",
        Provider::Anthropic=>"https://api.anthropic.com/v1/models",
        Provider::Gemini=>"https://generativelanguage.googleapis.com/v1beta/models",
        Provider::Xai=>"https://api.x.ai/v1/models",
    };
    let client=catalogue_client()?;
    let mut cursor=String::new();let mut models=Vec::new();let mut seen=std::collections::HashSet::new();
    for _ in 0..20 {
        let mut request=client.get(url);
        request=match provider {
            Provider::Anthropic=>request.header("x-api-key",key).header("anthropic-version","2023-06-01").query(&[("limit","1000")]),
            Provider::Gemini=>request.header("x-goog-api-key",key).query(&[("pageSize","1000")]),
            _=>request.bearer_auth(key),
        };
        if !cursor.is_empty() {request=request.query(&[(if provider==Provider::Gemini {"pageToken"}else{"after_id"},&cursor)]);}
        let mut response=request.send().await.context("Could not reach the model catalogue; check your network and retry")?;
        if !response.status().is_success() {
            let detail = provider_rejection(&mut response).await;
            bail!("{} model list returned HTTP {}. {}",provider.name(),response.status().as_u16(),detail);
        }
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await? {ensure!(bytes.len()+chunk.len()<=4*1024*1024,"Model catalogue is too large");bytes.extend_from_slice(&chunk);}
        let value:Value=serde_json::from_slice(&bytes)?;
        models.extend(model_options(provider,&value)?);
        cursor=match provider {
            Provider::Gemini=>value["nextPageToken"].as_str().unwrap_or("").into(),
            Provider::Anthropic if value["has_more"]==true=>value["last_id"].as_str().context("Missing model pagination cursor")?.into(),
            _=>String::new(),
        };
        if cursor.is_empty() {models.sort_by(|a,b|a.id.cmp(&b.id));models.dedup_by(|a,b|a.id==b.id);return Ok(models);}
        ensure!(seen.insert(cursor.clone()),"Provider repeated a model catalogue page");
    }
    bail!("Model catalogue pagination exceeded the safe response limit; retry later")
}

/// Marker written into ai-defaults.json by the consent-aware settings flow.
/// Files written before case-consent separation (R04) contain values that were
/// forced online/text/images/standard rather than chosen; they are ignored so a
/// new case starts local instead of inheriting unchosen grants.
pub const AI_DEFAULTS_CONSENT_VERSION: i64 = 2;

/// Parse saved app defaults for NEW-case initialization. Returns None unless
/// the file was written by the consent-aware flow and carries a complete,
/// valid configuration; callers then apply exactly this policy.
pub fn parse_ai_defaults(value:&Value)->Result<Option<(Config,crate::case::Settings)>> {
    if value["consent_version"].as_i64()!=Some(AI_DEFAULTS_CONSENT_VERSION) {
        return Ok(None);
    }
    let config:Config=serde_json::from_value(value["config"].clone())?;
    let settings:crate::case::Settings=serde_json::from_value(value["settings"].clone())?;
    config.validate()?;
    if !settings.model.is_empty(){validate_model(&settings.model)?;}
    Ok(Some((config,settings)))
}

/// Apply the app's chosen provider preferences to a case without copying any
/// credentials. R04: the exact chosen policy is saved — execution mode, review
/// mode, per-profile grants, offline state, and case grants.
/// Nothing is forced, so saving a model choice alone can neither broaden case
/// grants nor downgrade a stricter review mode.
pub fn apply_app_settings(case:&mut crate::case::Case,value:&Value)->Result<()> {
    let config:Config=serde_json::from_value(value["config"].clone())?;
    let settings:crate::case::Settings=serde_json::from_value(value["settings"].clone())?;
    config.validate()?;
    if settings.allow_images && !settings.allow_text {
        bail!("Image analysis always sends accompanying text; grant text before images");
    }
    if !settings.model.is_empty(){validate_model(&settings.model)?;}
    case.db.execute_batch("SAVEPOINT app_preferences")?;
    // Direct media (original audio/video transmission) stays a separate explicit
    // per-case opt-in; applying provider preferences never silently enables it.
    let result=(||->Result<()> {save(case,config)?;case.save_settings(settings)?;Ok(())})();
    match result {Ok(())=>case.db.execute_batch("RELEASE app_preferences")?,Err(error)=>{case.db.execute_batch("ROLLBACK TO app_preferences; RELEASE app_preferences")?;return Err(error);}}
    Ok(())
}

/// Explicit per-case direct-media consent (original audio/video transmission).
pub fn set_direct_media(case:&mut crate::case::Case,enabled:bool)->Result<()> {
    case.set_meta("gemini_direct_media",if enabled{"true"}else{"false"})?;
    case.audit("gemini_direct_media_permission",json!({"enabled":enabled}))?;
    Ok(())
}
pub fn direct_media_enabled(case:&crate::case::Case)->bool {
    case.meta("gemini_direct_media").ok().flatten().as_deref()==Some("true")
}
