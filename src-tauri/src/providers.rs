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
    Openrouter,
    Zai,
}
impl Provider {
    pub fn credential(self) -> &'static str {
        match self {
            Self::Openai => "openai-api-key",
            Self::Anthropic => "anthropic-api-key",
            Self::Gemini => "gemini-api-key",
            Self::Xai => "xai-api-key",
            Self::Openrouter => "openrouter-api-key",
            Self::Zai => "zai-api-key",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Gemini => "Gemini",
            Self::Xai => "xAI",
            Self::Openrouter => "OpenRouter",
            Self::Zai => "Z.ai",
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
/// The model name without a gateway vendor prefix or routing suffix:
/// "openai/gpt-5:nitro" -> "gpt-5". Used only to recognise model families.
pub fn base_model_id(model: &str) -> &str {
    let tail = model.rsplit('/').next().unwrap_or(model);
    tail.split(':').next().unwrap_or(tail)
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
/// Z.ai's GLM Coding Plan publishes GLM-5.3 as text-only and GLM-5.3-Flash
/// (plus the "V" vision family such as glm-4.6v) as image-capable. Other
/// providers' image support is left to their own APIs, as before.
pub fn model_sees_images(provider: Provider, model: &str) -> bool {
    if provider != Provider::Zai { return true; }
    let lower = base_model_id(model).to_ascii_lowercase();
    lower.starts_with("glm-5.3-flash")
        || lower.split('-').nth(1).is_some_and(|version| version.ends_with('v') && version.starts_with(|c: char| c.is_ascii_digit()))
}
/// The documented models a GLM Coding Plan key may call.
pub const ZAI_CODING_MODELS: [(&str, &str); 2] = [
    ("glm-5.3", "GLM-5.3 · max reasoning · text only"),
    ("glm-5.3-flash", "GLM-5.3-Flash · max reasoning · sees images"),
];
pub const ZAI_CODING_URL: &str = "https://api.z.ai/api/coding/paas/v4/chat/completions";
pub const TEXT_ONLY_VISUAL_REASON: &str = "vision_model_required: the default model is text-only (GLM-5.3 cannot see images). Add an image-capable model such as GLM-5.3-Flash with image permission in Settings → Accounts & models";
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
/// A text-only model never carries image permission, so image tools, forced
/// visual steps and image attachments are all withheld for it.
pub fn task_profile(case: &crate::case::Case, task: &str) -> Result<Profile> {
    let mut profile = if let Some(v) = case.meta(&format!("task_profile:{task}"))? {
        serde_json::from_str::<Profile>(&v)?
    } else {
        let s = case.settings()?;
        Profile {
            provider: load(case)?.provider,
            model: s.model,
            allow_text: s.allow_text,
            allow_images: s.allow_images,
        }
    };
    profile.allow_images &= model_sees_images(profile.provider, &profile.model);
    Ok(profile)
}
/// When the case default cannot see images, the first approved pool profile
/// that can and holds an image grant takes visual work. None means the default
/// handles it (or no image-capable route exists; see `visual_route_missing`).
pub fn visual_profile(case: &crate::case::Case) -> Result<Option<Profile>> {
    let settings = case.settings()?;
    let config = load(case)?;
    if !settings.allow_images || model_sees_images(config.provider, &settings.model) {
        return Ok(None);
    }
    Ok(config.pool.into_iter().find(|p| {
        p.allow_text && p.allow_images && model_sees_images(p.provider, &p.model) && check_permission(case, p).is_ok()
    }))
}
pub fn visual_route_missing(case: &crate::case::Case) -> Result<bool> {
    let settings = case.settings()?;
    let config = load(case)?;
    Ok(settings.allow_images && !model_sees_images(config.provider, &settings.model) && visual_profile(case)?.is_none())
}
pub fn check_permission(case: &crate::case::Case, p: &Profile) -> Result<()> {
    ensure!(
        p.provider != Provider::Openrouter || !openrouter_model_is_search(&p.model),
        "Web-search models are not permitted for case work: their search queries leave to third-party engines"
    );
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
/// Our Responses-shaped transcript as OpenAI-compatible chat messages
/// (OpenRouter and Z.ai). Tool results stay structured tool messages.
fn chat_completions_messages(body: &Value) -> Result<Vec<Value>> {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(instructions) = body["instructions"].as_str().filter(|s| !s.is_empty()) {
        messages.push(json!({"role":"system","content":instructions}));
    }
    for item in body["input"].as_array().context("Missing input")? {
        let kind = item["type"].as_str().unwrap_or("message");
        let message = match kind {
            "reasoning" | "provider_native" => continue,
            "function_call" => {
                let cid = item["call_id"].as_str().context("Missing call ID")?;
                let name = item["name"].as_str().context("Missing tool name")?;
                let args = item["arguments"].as_str().context("Missing tool arguments")?;
                serde_json::from_str::<Value>(args).context("Malformed tool arguments")?;
                json!({"role":"assistant","tool_calls":[{"id":cid,"type":"function","function":{"name":name,"arguments":args}}]})
            }
            "function_call_output" => {
                let cid = item["call_id"].as_str().context("Missing result call ID")?;
                json!({"role":"tool","tool_call_id":cid,"content":item["output"].as_str().unwrap_or("")})
            }
            _ => {
                let role = if item["role"] == "assistant" { "assistant" } else { "user" };
                let content = if let Some(text) = item["content"].as_str() {
                    if text.is_empty() { continue; }
                    json!(text)
                } else if let Some(parts) = item["content"].as_array() {
                    let mapped: Vec<Value> = parts.iter().filter_map(|part| {
                        if let Some(text) = part["text"].as_str().filter(|t| !t.is_empty()) {
                            Some(json!({"type":"text","text":text}))
                        } else if let Some(url) = part["image_url"].as_str() {
                            Some(json!({"type":"image_url","image_url":{"url":url}}))
                        } else {
                            None
                        }
                    }).collect();
                    if mapped.is_empty() { continue; }
                    json!(mapped)
                } else {
                    continue;
                };
                json!({"role":role,"content":content})
            }
        };
        // Merge consecutive assistant messages so text and tool calls share one turn.
        if message["role"] == "assistant"
            && messages.last().is_some_and(|last| last["role"] == "assistant" && last["tool_calls"].is_array())
            && message["tool_calls"].is_array()
        {
            messages.last_mut().unwrap()["tool_calls"].as_array_mut().unwrap().extend(message["tool_calls"].as_array().unwrap().iter().cloned());
        } else {
            messages.push(message);
        }
    }
    Ok(messages)
}
/// Z.ai GLM Coding Plan, OpenAI Chat Completions protocol. Thinking cannot be
/// disabled on GLM-5.3; reasoning runs at "max", the documented default and
/// the effort the user chose for this route. Z.ai accepts only
/// tool_choice "auto", so a required tool is stated as a directive and the
/// tool list (already narrowed by the coordinator) does the rest.
fn encode_zai(model: &str, body: &Value, mut messages: Vec<Value>, tools: Vec<Value>) -> Result<WireRequest> {
    let has_images = messages.iter().any(|m| m["content"].as_array().is_some_and(|parts| parts.iter().any(|p| p["type"] == "image_url")));
    ensure!(!has_images || model_sees_images(Provider::Zai, model), "{model} is text-only and cannot see images. Use an image-capable Z.ai model such as glm-5.3-flash for visual work");
    if let Some(name) = body["tool_choice"]["name"].as_str() {
        let directive = format!("Respond by calling the {name} tool now.");
        match messages.first_mut().filter(|m| m["role"] == "system") {
            Some(system) => system["content"] = json!(format!("{}
{directive}", system["content"].as_str().unwrap_or(""))),
            None => messages.insert(0, json!({"role":"system","content":directive})),
        }
    }
    let mut request = json!({"model":model,"messages":messages,"stream":true,"max_tokens":body["max_output_tokens"],"thinking":{"type":"enabled"},"reasoning_effort":"max"});
    if !tools.is_empty() {
        request["tools"] = json!(tools);
        request["tool_choice"] = json!("auto");
        // Streams tool arguments as they are generated (GLM-4.6 and later).
        if base_model_id(model).to_ascii_lowercase().starts_with("glm-5") { request["tool_stream"] = json!(true); }
    }
    Ok(WireRequest { url: ZAI_CODING_URL.into(), body: request })
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
    if matches!(provider, Provider::Openrouter | Provider::Zai) {
        ensure!(!body["input"].as_array().into_iter().flatten().flat_map(|i|i["content"].as_array().into_iter().flatten()).any(|p|p["type"]=="input_media"),"Direct media is supported only by Gemini");
        let messages = chat_completions_messages(body)?;
        let defs = body["tools"].as_array().cloned().unwrap_or_default();
        let tools: Vec<Value> = defs.iter().map(|t| json!({"type":"function","function":{"name":t["name"],"description":t["description"],"parameters":t["parameters"]}})).collect();
        if provider == Provider::Zai {
            return encode_zai(model, body, messages, tools);
        }
        // "deny" restricts routing to upstreams that do not store or train on
        // requests; OpenRouter's documented default is "allow".
        let mut request = json!({"model":model,"messages":messages,"tools":tools,"stream":true,"stream_options":{"include_usage":true},"max_tokens":body["max_output_tokens"],"provider":{"data_collection":"deny"}});
        // OpenRouter's unified reasoning parameter carries the same effort the
        // coordinator chose for direct OpenAI requests.
        if let Some(effort) = body["reasoning"]["effort"].as_str() { request["reasoning"] = json!({"effort": effort}); }
        request["tool_choice"] = match body["tool_choice"]["name"].as_str() {
            Some(name) => json!({"type":"function","function":{"name":name}}),
            None => json!("auto"),
        };
        return Ok(WireRequest { url: "https://openrouter.ai/api/v1/chat/completions".into(), body: request });
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
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse")
    };
    Ok(WireRequest { url, body: request })
}

pub fn decode(provider: Provider, response: Value) -> Result<Value> {
    if matches!(provider, Provider::Openai | Provider::Xai) {
        return Ok(response);
    }
    if matches!(provider, Provider::Openrouter | Provider::Zai) {
        let vendor = provider.name();
        let choice = response["choices"].get(0).with_context(|| format!("{vendor} returned no choices"))?;
        match choice["finish_reason"].as_str() {
            Some("stop" | "tool_calls") => {},
            Some("length") => bail!("{vendor} response incomplete: output token limit reached"),
            Some("model_context_window_exceeded") => bail!("{vendor} response incomplete: context window exceeded"),
            Some("content_filter" | "sensitive") => bail!("{vendor} response blocked by provider policy"),
            Some("network_error") => bail!("{vendor} reported a network error before completing the response"),
            _ => bail!("{vendor} did not complete the response"),
        }
        let mut output = Vec::new();
        if let Some(text) = choice["message"]["content"].as_str().filter(|t| !t.is_empty()) {
            output.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}));
        }
        for call in choice["message"]["tool_calls"].as_array().unwrap_or(&Vec::new()) {
            let function = call["function"].as_object().with_context(|| format!("Missing {vendor} tool function"))?;
            let id = call["id"].as_str().with_context(|| format!("Missing {vendor} tool call ID"))?;
            let name = function["name"].as_str().with_context(|| format!("Missing {vendor} tool name"))?;
            let arguments = match function["arguments"].as_str() { Some(a) if !a.trim().is_empty() => a, _ => "{}" };
            serde_json::from_str::<Value>(arguments).with_context(|| format!("Malformed {vendor} tool arguments"))?;
            output.push(json!({"type":"function_call","call_id":id,"name":name,"arguments":arguments}));
        }
        ensure!(!output.is_empty(), "{vendor} completed without text or tool calls");
        let usage = if provider == Provider::Zai { zai_usage(&response) } else { openrouter_usage(&response) };
        return Ok(json!({"status":"completed","output":output,"usage":usage}));
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
pub(crate) async fn provider_rejection(response: &mut reqwest::Response) -> String {
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

/// Gemini GenerateContent SSE yields response fragments. Preserve every signed
/// part in its original position; only adjacent unsigned text may be joined.
#[derive(Default)]
pub struct GeminiStream {
    parts: Vec<Value>,
    usage: Value,
}
/// OpenAI-compatible chat/completions SSE (OpenRouter, Z.ai). Tool call
/// fragments arrive by index across chunks; completion is emitted on the
/// trailing usage chunk when present, or on finish_reason otherwise.
#[derive(Default)]
pub struct ChatCompletionsStream {
    provider: Provider,
    text: String,
    tool_calls: std::collections::BTreeMap<usize, (String, String, String)>,
    finish_reason: Option<String>,
    usage: Value,
    completed: Option<Value>,
    generation_id: Option<String>,
    upstream: Option<String>,
    announced_generation: bool,
}
impl ChatCompletionsStream {
    pub fn new(provider: Provider) -> Self {
        Self { provider, ..Self::default() }
    }
    /// The generation id from the first chunk, reported once so the caller
    /// can persist it before the stream finishes (cost lookup after cancel).
    pub fn take_new_generation_id(&mut self) -> Option<String> {
        // Only OpenRouter offers a cost lookup by generation id.
        if self.announced_generation || self.provider != Provider::Openrouter { return None; }
        let id = self.generation_id.clone()?;
        self.announced_generation = true;
        Some(id)
    }
    /// Returns (text deltas, tool-name activity deltas, completed response).
    pub fn push(&mut self, chunk: &Value) -> Result<(Vec<String>, Vec<String>, Option<Value>)> {
        // An upstream failure after HTTP 200 arrives as an error object and/or
        // finish_reason "error"; report the bounded provider message.
        let vendor = self.provider.name();
        if chunk["error"].is_object() {
            bail!("{vendor} stream error: {}", stream_failure_detail(chunk));
        }
        if self.generation_id.is_none() {
            if let Some(id) = chunk["id"].as_str().filter(|id| valid_generation_id(id)) { self.generation_id = Some(id.into()); }
        }
        if self.upstream.is_none() && self.provider == Provider::Openrouter {
            if let Some(p) = chunk["provider"].as_str().filter(|p| !p.is_empty() && p.len() <= 80) { self.upstream = Some(p.into()); }
        }
        if !chunk["usage"].is_null() { self.usage = chunk["usage"].clone(); }
        let mut deltas = Vec::new();
        let mut activity = Vec::new();
        if let Some(choice) = chunk["choices"].get(0) {
            if choice["finish_reason"].as_str() == Some("error") {
                bail!("{vendor} stream error: {}", stream_failure_detail(chunk));
            }
            if let Some(reason) = choice["finish_reason"].as_str() {
                ensure!(self.finish_reason.is_none(), "Duplicate {vendor} finish reason");
                self.finish_reason = Some(reason.into());
            }
            if let Some(delta) = choice["delta"].as_object() {
                if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    self.text.push_str(text);
                    deltas.push(text.to_string());
                }
                for call in delta.get("tool_calls").and_then(Value::as_array).unwrap_or(&Vec::new()) {
                    // A whole (unstreamed) call may omit its index; a new id
                    // then opens the next slot rather than merging into slot 0.
                    let index = match call["index"].as_u64() {
                        Some(index) => index as usize,
                        None => match call["id"].as_str().filter(|id| !id.is_empty()) {
                            Some(id) => self.tool_calls.iter().find(|(_, slot)| slot.0 == id).map(|(i, _)| *i).unwrap_or(self.tool_calls.len()),
                            None => self.tool_calls.keys().last().copied().unwrap_or(0),
                        },
                    };
                    ensure!(index < 100, "Excessive {vendor} tool call index");
                    let slot = self.tool_calls.entry(index).or_default();
                    if let Some(id) = call["id"].as_str().filter(|v| !v.is_empty()) { slot.0 = id.into(); }
                    if let Some(name) = call["function"]["name"].as_str().filter(|v| !v.is_empty()) {
                        if slot.1.is_empty() { activity.push(name.to_string()); }
                        slot.1 = name.into();
                    }
                    if let Some(args) = call["function"]["arguments"].as_str() { slot.2.push_str(args); }
                }
            }
        }
        if self.finish_reason.is_some() && self.completed.is_none() {
            let tool_calls: Vec<Value> = self.tool_calls.values()
                .map(|(id, name, args)| json!({"id":id,"type":"function","function":{"name":name,"arguments":args}}))
                .collect();
            let message = json!({
                "role":"assistant",
                "content": if self.text.is_empty() { Value::Null } else { json!(self.text) },
                "tool_calls": if tool_calls.is_empty() { Value::Null } else { json!(tool_calls) },
            });
            self.completed = Some(json!({"id":self.generation_id,"provider":self.upstream,"choices":[{"message":message,"finish_reason":self.finish_reason}],"usage":self.usage.clone()}));
            // The usage-only chunk that follows (stream_options.include_usage)
            // carries final token counts; emit then. Without it, take_completed()
            // after the loop emits what arrived.
        }
        if !chunk["usage"].is_null() && self.completed.is_some() {
            let mut response = self.completed.take().context("Chat completion vanished")?;
            response["usage"] = self.usage.clone();
            return Ok((deltas, activity, Some(decode(self.provider, response)?)));
        }
        Ok((deltas, activity, None))
    }
    pub fn take_completed(&mut self) -> Option<anyhow::Result<Value>> {
        let provider = self.provider;
        self.completed.take().map(|response| decode(provider, response))
    }
}
/// Usage as OpenRouter reported it. Cost is copied only when the provider
/// reported a finite, non-negative number; absence stays absent so the UI can
/// say "not reported" instead of showing zero.
fn openrouter_usage(response: &Value) -> Value {
    let usage = &response["usage"];
    let mut out = json!({"input_tokens":usage["prompt_tokens"],"output_tokens":usage["completion_tokens"]});
    if let Some(cost) = usage["cost"].as_f64().filter(|c| c.is_finite() && *c >= 0.0) { out["cost"] = json!(cost); }
    if let Some(n) = usage["prompt_tokens_details"]["cached_tokens"].as_u64() { out["cached_tokens"] = json!(n); }
    if let Some(n) = usage["completion_tokens_details"]["reasoning_tokens"].as_u64() { out["reasoning_tokens"] = json!(n); }
    if let Some(id) = response["id"].as_str().filter(|id| valid_generation_id(id)) { out["generation_id"] = json!(id); }
    if let Some(upstream) = response["provider"].as_str().filter(|p| p.len() <= 80) { out["upstream_provider"] = json!(upstream); }
    out
}
/// Z.ai reports tokens only; the coding plan bills in quota points, so no
/// cost is recorded and the UI says it was not reported.
fn zai_usage(response: &Value) -> Value {
    let usage = &response["usage"];
    let mut out = json!({"input_tokens":usage["prompt_tokens"],"output_tokens":usage["completion_tokens"]});
    if let Some(n) = usage["prompt_tokens_details"]["cached_tokens"].as_u64() { out["cached_tokens"] = json!(n); }
    if let Some(n) = usage["completion_tokens_details"]["reasoning_tokens"].as_u64() { out["reasoning_tokens"] = json!(n); }
    out
}
/// Generation identifiers are opaque; accept only short printable ASCII so a
/// hostile stream cannot inject arbitrary text into the ledger or UI.
fn valid_generation_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
}
/// Model families that run web search on the prompt. Search queries leave to
/// third-party engines outside the provider's retention terms, so case text
/// must never reach them through the OpenRouter route.
pub fn openrouter_model_is_search(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    lower.ends_with(":online")
        || lower.starts_with("perplexity/")
        || lower.contains("search-preview")
        || lower.contains("-search")
        || lower.contains("deep-research")
        || lower.contains("/sonar")
}
impl GeminiStream {
    pub fn push(&mut self, chunk: &Value) -> Result<(Vec<String>, Option<Value>)> {
        if !chunk["usageMetadata"].is_null() { self.usage = chunk["usageMetadata"].clone(); }
        let candidate = &chunk["candidates"][0];
        if chunk["candidates"].as_array().is_some_and(|items| items.len() > 1) {
            bail!("Gemini returned multiple candidates for a single-answer request");
        }
        let mut deltas = Vec::new();
        if let Some(parts) = candidate["content"]["parts"].as_array() {
            for part in parts {
                ensure!(part.is_object(), "Invalid Gemini stream part");
                if part["functionCall"].is_object() {
                    ensure!(part["functionCall"]["name"].as_str().is_some() && part["functionCall"]["args"].is_object(), "Incomplete Gemini function call");
                }
                let unsigned_text = part["text"].as_str().is_some() && part["thought"] != true && part["thoughtSignature"].is_null();
                if unsigned_text && self.parts.last().is_some_and(|last| last["text"].as_str().is_some() && last["thought"] != true && last["thoughtSignature"].is_null()) {
                    let last = self.parts.last_mut().unwrap();
                    last["text"] = json!(format!("{}{}", last["text"].as_str().unwrap_or(""), part["text"].as_str().unwrap_or("")));
                } else {
                    self.parts.push(part.clone());
                }
                if part["thought"] != true {
                    if let Some(text) = part["text"].as_str().filter(|text| !text.is_empty()) { deltas.push(text.to_string()); }
                }
            }
        }
        if candidate["finishReason"].as_str().is_some() || chunk["promptFeedback"]["blockReason"].as_str().is_some() {
            let response = json!({"candidates":[{"finishReason":candidate["finishReason"],"content":{"parts":std::mem::take(&mut self.parts)}}],"promptFeedback":chunk["promptFeedback"],"usageMetadata":self.usage});
            return Ok((deltas, Some(decode(Provider::Gemini, response)?)));
        }
        Ok((deltas, None))
    }
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

pub(crate) fn inference_client() -> Result<reqwest::Client> {
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

/// Tool names in one streamed Gemini event's function-call parts.
fn gemini_function_calls(event: &Value) -> Vec<String> {
    event["candidates"].as_array().into_iter().flatten()
        .flat_map(|candidate| candidate["content"]["parts"].as_array().into_iter().flatten())
        .filter_map(|part| part["functionCall"]["name"].as_str().map(str::to_owned))
        .collect()
}

pub async fn send(
    provider: Provider,
    key: &str,
    body: Value,
    progress: impl FnMut(Value),
) -> Result<Value> {
    let mut wire = encode(provider, &body)?;
    // The packaged debug acceptance harness may replace the network endpoint
    // with a loopback server. Release builds have no endpoint override.
    if let Some(url) = synthetic_provider_url()? { wire.url = url; }
    send_wire(provider, key, wire, progress).await
}

async fn send_wire(provider: Provider, key: &str, wire: WireRequest, mut progress: impl FnMut(Value)) -> Result<Value> {
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
    let mut stream = crate::agent::ResponseStream::default();
    let mut claude = ClaudeStream::default();
    let mut gemini = GeminiStream::default();
    let mut chat = ChatCompletionsStream::new(provider);
    while let Some(chunk) = response.chunk().await? {
        for event in stream.push(&chunk)? {
            if provider == Provider::Anthropic {
                if let Some(value) = claude.push(&event)? { return Ok(value); }
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta" {
                    progress(json!({"text":event["delta"]["text"]}));
                }
                // Tool-use progress, as the OpenAI branch reports it: the tool
                // name when the call starts, then argument characters received.
                if event["type"] == "content_block_start" && event["content_block"]["type"] == "tool_use" {
                    if let Some(name) = event["content_block"]["name"].as_str() { progress(json!({"activity":name})); }
                }
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "input_json_delta" {
                    progress(json!({"characters":event["delta"]["partial_json"].as_str().map(str::len).unwrap_or(0)}));
                }
                continue;
            }
            if provider == Provider::Gemini {
                let (deltas, completed) = gemini.push(&event)?;
                for delta in deltas { progress(json!({"text":delta})); }
                for name in gemini_function_calls(&event) { progress(json!({"activity":name})); }
                if let Some(value) = completed { return Ok(value); }
                continue;
            }
            if matches!(provider, Provider::Openrouter | Provider::Zai) {
                let (deltas, activity, completed) = chat.push(&event)?;
                if let Some(id) = chat.take_new_generation_id() { progress(json!({"generation_id":id})); }
                for delta in deltas { progress(json!({"text":delta})); }
                for name in activity { progress(json!({"activity":name})); }
                if let Some(value) = completed { return Ok(value); }
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
    if matches!(provider, Provider::Openrouter | Provider::Zai) {
        if let Some(result) = chat.take_completed() { return result; }
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
    let mut profile = profile;
    profile.allow_images &= model_sees_images(profile.provider, &profile.model);
    validate_model(&profile.model)?;
    check_permission(case, &profile)?;
    Ok(profile)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelOption {
    pub id: String,
    pub name: String,
    /// Published catalogue facts (OpenRouter only). Absent means unknown,
    /// never "unsupported"; they are shown, not used to widen any grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_modalities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    /// USD per token as published, kept as text to avoid rounding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_price: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_price: Option<String>,
}
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
            Provider::Zai => lower.starts_with("glm-") && !["ocr","asr","image","video","tts","embedding"].iter().any(|part|lower.contains(part)),
            // OpenRouter publishes capabilities: keep models that answer in text
            // and accept tool calls (the agent needs them). Only when that
            // metadata is missing fall back to excluding non-chat name families.
            // Web-search models are never offered for case work.
            Provider::Openrouter => !openrouter_model_is_search(id) && match row["architecture"]["output_modalities"].as_array() {
                Some(outputs) => outputs.iter().any(|m| m == "text")
                    && row["supported_parameters"].as_array().is_none_or(|params| params.iter().any(|p| p == "tools")),
                None => !["image","video","tts","audio","realtime","embed","rerank","moderation","speech","voice","whisper","dall-e","sora","veo","imagen","safe"].iter().any(|part|lower.contains(part)),
            },
        };
        if candidate {
            let text_list = |value: &Value| value.as_array().map(|items| items.iter().filter_map(Value::as_str).map(|s| s.chars().take(20).collect::<String>()).take(8).collect::<Vec<_>>());
            let price = |value: &Value| value.as_str().filter(|p| p.len() <= 24 && p.parse::<f64>().is_ok_and(|n| n.is_finite() && n >= 0.0)).map(str::to_string);
            let openrouter = provider == Provider::Openrouter;
            result.push(ModelOption{id:id.into(),name:row[
                if provider==Provider::Gemini {"displayName"}
                else if provider==Provider::Openrouter {"name"}
                else {"display_name"}
            ].as_str().unwrap_or(id).into(),
            input_modalities: if openrouter { text_list(&row["architecture"]["input_modalities"]) } else { None },
            context_length: if openrouter { row["context_length"].as_u64() } else { None },
            prompt_price: if openrouter { price(&row["pricing"]["prompt"]) } else { None },
            completion_price: if openrouter { price(&row["pricing"]["completion"]) } else { None }});
        }
    }
    result.sort_by(|a,b|a.id.cmp(&b.id));result.dedup_by(|a,b|a.id==b.id);Ok(result)
}
/// The GLM Coding Plan publishes no model catalogue on its endpoint; offer
/// the documented plan models with their documented input modalities.
pub fn zai_coding_models() -> Vec<ModelOption> {
    ZAI_CODING_MODELS.iter().map(|(id, name)| ModelOption {
        id: (*id).into(),
        name: (*name).into(),
        input_modalities: Some(if model_sees_images(Provider::Zai, id) { vec!["text".into(), "image".into()] } else { vec!["text".into()] }),
        context_length: Some(1_000_000),
        prompt_price: None,
        completion_price: None,
    }).collect()
}
pub async fn list_models(provider: Provider, key: &str) -> Result<Vec<ModelOption>> {
    if provider == Provider::Zai {
        ensure!(!key.trim().is_empty(), "Add a Z.ai GLM Coding Plan API key");
        return Ok(zai_coding_models());
    }
    let url=match provider {
        Provider::Openai=>"https://api.openai.com/v1/models",
        Provider::Anthropic=>"https://api.anthropic.com/v1/models",
        Provider::Gemini=>"https://generativelanguage.googleapis.com/v1beta/models",
        Provider::Xai=>"https://api.x.ai/v1/models",
        Provider::Openrouter=>"https://openrouter.ai/api/v1/models",
        Provider::Zai=>unreachable!("Z.ai models are documented, not fetched"),
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
    let mut settings:crate::case::Settings=serde_json::from_value(value["settings"].clone())?;
    config.validate()?;
    if settings.allow_images && !settings.allow_text {
        bail!("Image analysis always sends accompanying text; grant text before images");
    }
    if !settings.model.is_empty(){validate_model(&settings.model)?;}
    // A grant is consent to send case material to one vendor. Changing the
    // default vendor keeps the grant only when the caller explicitly names the
    // new provider as the recipient of that consent; otherwise it resets, as
    // `save` already does for bare configuration changes.
    if load(case)?.provider != config.provider
        && value["grants_for_provider"] != serde_json::to_value(config.provider)?
    {
        settings.allow_text = false;
        settings.allow_images = false;
    }
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

#[cfg(test)]
mod stream_transport_tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn gemini_function_call_names_are_reported_as_activity() {
        let event = json!({"candidates":[{"content":{"parts":[{"text":"x"},{"functionCall":{"name":"search_passages","args":{}}}]}}]});
        assert_eq!(gemini_function_calls(&event), vec!["search_passages".to_string()]);
        assert!(gemini_function_calls(&json!({"candidates":[{"content":{"parts":[{"text":"only text"}]}}]})).is_empty());
        assert!(gemini_function_calls(&json!({})).is_empty());
    }

    fn local_sse(events: Vec<Value>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request = [0u8; 8192];
            let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
            for event in events {
                socket.write_all(format!("data: {event}\n\n").as_bytes()).unwrap();
                socket.flush().unwrap();
            }
        });
        (url, server)
    }

    fn local_sse_lines(lines: Vec<String>) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request = [0u8; 8192];
            let _ = socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
            for line in lines {
                socket.write_all(format!("{line}\n").as_bytes()).unwrap();
                socket.flush().unwrap();
            }
        });
        (url, server)
    }

    #[test]
    fn openrouter_encode_translates_tool_transcript() {
        let body = json!({
            "model":"anthropic/claude-haiku",
            "instructions":"Case rules",
            "max_output_tokens":1024,
            "tool_choice":{"name":"search_passages"},
            "tools":[{"name":"search_passages","description":"Search","parameters":{"type":"object"}}],
            "input":[
                {"type":"message","role":"user","content":"Check the statement"},
                {"type":"function_call","call_id":"call-1","name":"search_passages","arguments":"{\"query\":\"statement\"}"},
                {"type":"function_call_output","call_id":"call-1","output":"2 hits"},
            ]
        });
        let wire = encode(Provider::Openrouter, &body).unwrap();
        assert_eq!(wire.url, "https://openrouter.ai/api/v1/chat/completions");
        assert_eq!(wire.body["messages"][0]["role"], "system");
        assert_eq!(wire.body["messages"][1]["content"], "Check the statement");
        assert_eq!(wire.body["messages"][2]["tool_calls"][0]["function"]["name"], "search_passages");
        assert_eq!(wire.body["messages"][3]["role"], "tool");
        assert_eq!(wire.body["messages"][3]["tool_call_id"], "call-1");
        assert_eq!(wire.body["tool_choice"]["function"]["name"], "search_passages");
        assert_eq!(wire.body["tools"][0]["type"], "function");
        assert_eq!(wire.body["stream"], true);
        assert_eq!(wire.body["stream_options"]["include_usage"], true);
        // Case material may only reach OpenRouter upstreams that do not store
        // or train on it (OpenRouter's own default is "allow").
        assert_eq!(wire.body["provider"]["data_collection"], "deny");
    }

    fn sse_data(event: Value) -> String {
        format!("data: {event}")
    }

    #[tokio::test]
    async fn openrouter_transport_streams_tools_and_ignores_keepalive_comments() {
        let tool_open = json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search_passages","arguments":"{\"query\":"}}]}}]});
        let tool_args = json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"statement\"}"}}]}}]});
        let lines = vec![
            ": OPENROUTER PROCESSING".to_string(),
            sse_data(json!({"choices":[{"delta":{"role":"assistant","content":"Synthetic "}}]})),
            ": OPENROUTER PROCESSING".to_string(),
            sse_data(json!({"choices":[{"delta":{"content":"answer"}}]})),
            sse_data(tool_open),
            sse_data(tool_args),
            sse_data(json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]})),
            ": OPENROUTER PROCESSING".to_string(),
            sse_data(json!({"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}})),
            "data: [DONE]".to_string(),
        ];
        let (url, server) = local_sse_lines(lines);
        let mut progress = Vec::new();
        let response = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |delta| progress.push(delta)).await.unwrap();
        server.join().unwrap();
        assert_eq!(progress, vec![
            json!({"text":"Synthetic "}),
            json!({"text":"answer"}),
            json!({"activity":"search_passages"}),
        ]);
        assert_eq!(response["output"][0]["content"][0]["text"], "Synthetic answer");
        assert_eq!(response["output"][1]["type"], "function_call");
        assert_eq!(response["output"][1]["call_id"], "call-1");
        assert_eq!(response["output"][1]["arguments"], "{\"query\":\"statement\"}");
        assert_eq!(response["usage"]["input_tokens"], 5);
        assert_eq!(response["usage"]["output_tokens"], 2);
    }

    #[tokio::test]
    async fn openrouter_transport_completes_without_a_trailing_usage_chunk() {
        let lines = vec![
            sse_data(json!({"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]})),
            "data: [DONE]".to_string(),
        ];
        let (url, server) = local_sse_lines(lines);
        let response = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |_| {}).await.unwrap();
        server.join().unwrap();
        assert_eq!(response["output"][0]["content"][0]["text"], "Done");
        assert!(response["usage"]["input_tokens"].is_null());
    }

    #[tokio::test]
    async fn openrouter_transport_rejects_truncated_responses() {
        let lines = vec![
            sse_data(json!({"choices":[{"delta":{"content":"Partial"},"finish_reason":"length"}]})),
        ];
        let (url, server) = local_sse_lines(lines);
        let error = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |_| {}).await.unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("output token limit"));
    }

    #[tokio::test]
    async fn openrouter_transport_reports_generation_cost_and_upstream() {
        let lines = vec![
            sse_data(json!({"id":"gen-synthetic-1","provider":"SyntheticUpstream","choices":[{"delta":{"content":"Done"}}]})),
            sse_data(json!({"id":"gen-synthetic-1","provider":"SyntheticUpstream","choices":[{"delta":{},"finish_reason":"stop"}]})),
            sse_data(json!({"id":"gen-synthetic-1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"cost":0.00042,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":1}}})),
            "data: [DONE]".to_string(),
        ];
        let (url, server) = local_sse_lines(lines);
        let mut progress = Vec::new();
        let response = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |delta| progress.push(delta)).await.unwrap();
        server.join().unwrap();
        // The generation id is announced once, before any text, so it can be
        // persisted while the request is still pending.
        assert_eq!(progress[0], json!({"generation_id":"gen-synthetic-1"}));
        assert_eq!(progress.iter().filter(|p| p.get("generation_id").is_some()).count(), 1);
        let usage = &response["usage"];
        assert_eq!(usage["input_tokens"], 7);
        assert_eq!(usage["output_tokens"], 3);
        assert_eq!(usage["cost"], 0.00042);
        assert_eq!(usage["cached_tokens"], 4);
        assert_eq!(usage["reasoning_tokens"], 1);
        assert_eq!(usage["generation_id"], "gen-synthetic-1");
        assert_eq!(usage["upstream_provider"], "SyntheticUpstream");
    }

    #[tokio::test]
    async fn openrouter_transport_leaves_unreported_or_invalid_cost_absent() {
        let lines = vec![
            sse_data(json!({"id":"bad id with spaces","choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]})),
            sse_data(json!({"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"cost":-5}})),
        ];
        let (url, server) = local_sse_lines(lines);
        let mut progress = Vec::new();
        let response = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |delta| progress.push(delta)).await.unwrap();
        server.join().unwrap();
        assert!(response["usage"].get("cost").is_none());
        assert!(response["usage"].get("generation_id").is_none());
        assert!(progress.iter().all(|p| p.get("generation_id").is_none()));
    }

    #[tokio::test]
    async fn openrouter_transport_surfaces_mid_stream_errors() {
        let lines = vec![
            sse_data(json!({"choices":[{"delta":{"content":"Partial"}}]})),
            sse_data(json!({"error":{"code":502,"message":"Synthetic upstream overloaded"},"choices":[{"delta":{},"finish_reason":"error"}]})),
        ];
        let (url, server) = local_sse_lines(lines);
        let error = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |_| {}).await.unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("Synthetic upstream overloaded"), "{error}");
        let long = "x".repeat(2000);
        let lines = vec![sse_data(json!({"choices":[{"delta":{},"finish_reason":"error"}],"message":long}))];
        let (url, server) = local_sse_lines(lines);
        let error = send_wire(Provider::Openrouter, "synthetic-key", WireRequest { url, body: json!({"model":"vendor/model","stream":true}) }, |_| {}).await.unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().len() < 500, "provider detail must stay bounded");
    }

    #[test]
    fn gateway_model_ids_are_normalised_and_reasoning_effort_is_forwarded() {
        assert_eq!(base_model_id("openai/gpt-5"), "gpt-5");
        assert_eq!(base_model_id("openai/gpt-5-mini:nitro"), "gpt-5-mini");
        assert_eq!(base_model_id("gpt-5"), "gpt-5");
        let body = json!({"model":"openai/gpt-5","instructions":"Rules","max_output_tokens":16384,"reasoning":{"effort":"high"},"tools":[],"input":[{"type":"message","role":"user","content":"Question"}]});
        let wire = encode(Provider::Openrouter, &body).unwrap();
        assert_eq!(wire.body["reasoning"], json!({"effort":"high"}));
        assert_eq!(wire.body["max_tokens"], 16384);
        let plain = encode(Provider::Openrouter, &json!({"model":"vendor/model","instructions":"Rules","max_output_tokens":4096,"tools":[],"input":[]})).unwrap();
        assert!(plain.body.get("reasoning").is_none());
    }

    #[test]
    fn openrouter_web_search_models_are_recognised() {
        for model in ["openai/gpt-5:online", "perplexity/sonar-pro", "openai/gpt-4o-search-preview", "openai/o3-deep-research", "vendor/model-search"] {
            assert!(openrouter_model_is_search(model), "{model}");
        }
        for model in ["openai/gpt-5", "anthropic/claude-sonnet-5", "deepseek/deepseek-chat", "google/gemini-2.5-flash", "vendor/research-assistant"] {
            assert!(!openrouter_model_is_search(model), "{model}");
        }
    }

    #[test]
    fn zai_vision_support_follows_the_published_model_cards() {
        assert!(!model_sees_images(Provider::Zai, "glm-5.3"));
        assert!(!model_sees_images(Provider::Zai, "glm-4.7-flash"));
        assert!(model_sees_images(Provider::Zai, "glm-5.3-flash"));
        assert!(model_sees_images(Provider::Zai, "GLM-5.3-Flash"));
        assert!(model_sees_images(Provider::Zai, "glm-4.6v"));
        assert!(model_sees_images(Provider::Openai, "gpt-5"));
        let models = zai_coding_models();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["glm-5.3", "glm-5.3-flash"]);
        assert_eq!(models[0].input_modalities, Some(vec!["text".to_string()]));
        assert_eq!(models[1].input_modalities, Some(vec!["text".to_string(), "image".to_string()]));
    }

    #[test]
    fn zai_encode_uses_the_coding_plan_endpoint_with_max_reasoning() {
        let body = json!({
            "model":"glm-5.3",
            "instructions":"Case rules",
            "max_output_tokens":32768,
            "reasoning":{"effort":"high"},
            "tool_choice":{"type":"function","name":"finish_task"},
            "tools":[{"name":"finish_task","description":"Finish","parameters":{"type":"object"}}],
            "input":[
                {"type":"message","role":"user","content":"Check the statement"},
                {"type":"function_call","call_id":"call-1","name":"finish_task","arguments":"{}"},
                {"type":"function_call_output","call_id":"call-1","output":"review needed"},
            ]
        });
        let wire = encode(Provider::Zai, &body).unwrap();
        assert_eq!(wire.url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
        assert_eq!(wire.body["model"], "glm-5.3");
        assert_eq!(wire.body["thinking"], json!({"type":"enabled"}));
        assert_eq!(wire.body["reasoning_effort"], "max");
        assert_eq!(wire.body["max_tokens"], 32768);
        assert_eq!(wire.body["stream"], true);
        assert_eq!(wire.body["tool_stream"], true);
        // Z.ai accepts only "auto"; the required tool becomes a directive.
        assert_eq!(wire.body["tool_choice"], "auto");
        assert!(wire.body["messages"][0]["content"].as_str().unwrap().ends_with("Respond by calling the finish_task tool now."));
        assert_eq!(wire.body["messages"][2]["tool_calls"][0]["function"]["name"], "finish_task");
        assert_eq!(wire.body["messages"][3]["role"], "tool");
        // OpenRouter-only routing fields never reach Z.ai.
        assert!(wire.body.get("provider").is_none());
        assert!(wire.body.get("stream_options").is_none());
        assert!(wire.body.get("reasoning").is_none());
        let plain = encode(Provider::Zai, &json!({"model":"glm-5.3","instructions":"","max_output_tokens":10,"tools":[],"input":[{"type":"message","role":"user","content":"Hi"}]})).unwrap();
        assert!(plain.body.get("tools").is_none() && plain.body.get("tool_choice").is_none());
    }

    #[test]
    fn zai_text_only_model_refuses_images_and_flash_accepts_them() {
        let image = |model: &str| json!({"model":model,"instructions":"Rules","max_output_tokens":10,"tools":[],"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Frame"},{"type":"input_image","image_url":"data:image/jpeg;base64,AAAA"}]}]});
        let error = encode(Provider::Zai, &image("glm-5.3")).err().expect("text-only image request must fail").to_string();
        assert!(error.contains("text-only") && error.contains("glm-5.3-flash"), "{error}");
        let wire = encode(Provider::Zai, &image("glm-5.3-flash")).unwrap();
        assert_eq!(wire.body["messages"][1]["content"][1], json!({"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AAAA"}}));
    }

    #[tokio::test]
    async fn zai_transport_streams_text_and_whole_tool_calls() {
        let lines = vec![
            sse_data(json!({"id":"zai-1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking privately"}}]})),
            sse_data(json!({"id":"zai-1","choices":[{"index":0,"delta":{"content":"Synthetic "}}]})),
            sse_data(json!({"id":"zai-1","choices":[{"index":0,"delta":{"content":"answer"}}]})),
            sse_data(json!({"id":"zai-1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"search_passages","arguments":"{\"query\":\"door\"}"}},{"id":"call_b","type":"function","function":{"name":"read_text","arguments":"{}"}}]}}]})),
            sse_data(json!({"id":"zai-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2},"completion_tokens_details":{"reasoning_tokens":3}}})),
            "data: [DONE]".to_string(),
        ];
        let (url, server) = local_sse_lines(lines);
        let mut progress = Vec::new();
        let response = send_wire(Provider::Zai, "synthetic-key", WireRequest { url, body: json!({"model":"glm-5.3","stream":true}) }, |delta| progress.push(delta)).await.unwrap();
        server.join().unwrap();
        // Hidden reasoning is never shown; no OpenRouter generation id is announced.
        assert_eq!(progress, vec![
            json!({"text":"Synthetic "}),
            json!({"text":"answer"}),
            json!({"activity":"search_passages"}),
            json!({"activity":"read_text"}),
        ]);
        assert_eq!(response["output"][0]["content"][0]["text"], "Synthetic answer");
        assert_eq!(response["output"][1]["call_id"], "call_a");
        assert_eq!(response["output"][1]["arguments"], "{\"query\":\"door\"}");
        assert_eq!(response["output"][2]["call_id"], "call_b");
        let usage = &response["usage"];
        assert_eq!((usage["input_tokens"].as_u64(), usage["output_tokens"].as_u64()), (Some(9), Some(4)));
        assert_eq!(usage["cached_tokens"], 2);
        assert_eq!(usage["reasoning_tokens"], 3);
        assert!(usage.get("cost").is_none() && usage.get("generation_id").is_none());
    }

    #[tokio::test]
    async fn zai_transport_reports_policy_blocks_and_errors_by_name() {
        let lines = vec![sse_data(json!({"choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":"sensitive"}]}))];
        let (url, server) = local_sse_lines(lines);
        let error = send_wire(Provider::Zai, "synthetic-key", WireRequest { url, body: json!({"model":"glm-5.3"}) }, |_| {}).await.unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("Z.ai response blocked by provider policy"), "{error}");
        let lines = vec![sse_data(json!({"error":{"code":"1302","message":"Synthetic rate limit"}}))];
        let (url, server) = local_sse_lines(lines);
        let error = send_wire(Provider::Zai, "synthetic-key", WireRequest { url, body: json!({"model":"glm-5.3"}) }, |_| {}).await.unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("Z.ai stream error: Synthetic rate limit"), "{error}");
    }

    #[tokio::test]
    async fn claude_transport_streams_text_but_requires_message_stop() {
        let events = vec![
            json!({"type":"message_start","message":{"role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":3}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Synthetic answer"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}),
            json!({"type":"message_stop"}),
        ];
        let (url, server) = local_sse(events.clone());
        let mut progress = Vec::new();
        let response = send_wire(Provider::Anthropic, "synthetic-key", WireRequest { url, body: json!({"model":"synthetic-model","stream":true}) }, |delta| progress.push(delta)).await.unwrap();
        server.join().unwrap();
        assert_eq!(progress, vec![json!({"text":"Synthetic answer"})]);
        assert_eq!(response["output"][0]["content"][0]["text"], "Synthetic answer");
        assert_eq!(response["usage"]["output_tokens"], 2);

        let (url, server) = local_sse(events[..3].to_vec());
        let mut draft = Vec::new();
        let error = send_wire(Provider::Anthropic, "synthetic-key", WireRequest { url, body: json!({"model":"synthetic-model","stream":true}) }, |delta| draft.push(delta)).await.unwrap_err();
        server.join().unwrap();
        assert_eq!(draft, vec![json!({"text":"Synthetic answer"})]);
        assert!(error.to_string().contains("without completion"));
    }

    #[tokio::test]
    async fn gemini_transport_keeps_last_signed_part_before_completion() {
        let events = vec![
            json!({"candidates":[{"content":{"parts":[{"text":"Synthetic "}]}}]}),
            json!({"candidates":[{"content":{"parts":[{"text":"answer"},{"text":"","thoughtSignature":"final-sig"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}),
        ];
        let (url, server) = local_sse(events.clone());
        let mut progress = Vec::new();
        let response = send_wire(Provider::Gemini, "synthetic-key", WireRequest { url, body: json!({"contents":[]}) }, |delta| progress.push(delta)).await.unwrap();
        server.join().unwrap();
        assert_eq!(progress, vec![json!({"text":"Synthetic "}),json!({"text":"answer"})]);
        assert_eq!(response["output"][0]["content"][0]["text"], "Synthetic answer");
        assert_eq!(response["output"][1]["native_part"]["thoughtSignature"], "final-sig");

        let (url, server) = local_sse(events[..1].to_vec());
        let error = send_wire(Provider::Gemini, "synthetic-key", WireRequest { url, body: json!({"contents":[]}) }, |_| {}).await.unwrap_err();
        server.join().unwrap();
        assert!(error.to_string().contains("without completion"));
    }
}
