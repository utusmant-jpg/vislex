//! Optional "second opinion" for uncertain audio.
//!
//! Local transcription stays authoritative and complete. This module finds
//! segments where the local recogniser's own diagnostics suggest a human should
//! check the audio (triage), which is useful with no network at all. Sending a
//! clip to a remote model is a separate, per-case, human-confirmed step; its
//! result is only ever an unreviewed interpretation, never a transcript edit.
//!
//! The scores are transparent heuristics over decoder diagnostics
//! (avg_logprob, no_speech_prob, compression_ratio, temperature, per-word
//! probability, language probability). They are not calibrated accuracy and
//! must never be shown as percentages. Thresholds are to be calibrated on
//! synthetic clips only (see docs/implementation/FUNCTIONAL-PLAN.md, Phase 5).
use crate::case::Case;
use anyhow::{ensure, Context, Result};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};

/// A segment is flagged when any signal reaches this level.
pub const FLAG_THRESHOLD: f64 = 0.5;
/// Flagged segments closer than this are sent as one clip.
pub const MERGE_GAP_SECONDS: f64 = 1.5;
/// Context kept on each side of a clip.
pub const PAD_SECONDS: f64 = 0.5;
/// Longest clip ever proposed.
pub const MAX_CLIP_SECONDS: f64 = 30.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Reason {
    /// Stable identifier, for example "low_avg_logprob".
    pub code: &'static str,
    /// Plain-language explanation shown to reviewers.
    pub detail: String,
    /// Signal strength in [0, 1]; a heuristic, not a probability.
    pub strength: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SegmentScore {
    pub ordinal: i64,
    pub track: i64,
    pub start: f64,
    pub end: f64,
    pub risk: f64,
    pub reasons: Vec<Reason>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub track: i64,
    /// Clip bounds in source-track seconds, padded and capped.
    pub start: f64,
    pub end: f64,
    pub ordinals: Vec<i64>,
    pub risk: f64,
    pub reasons: Vec<Reason>,
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 }
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite())
}

/// Words whose misrecognition changes legal meaning weigh more: digits,
/// capitalised non-initial tokens (names, places) and negations.
fn high_stakes(word: &str, index: usize) -> bool {
    let token = word.trim().trim_matches(|c: char| c.is_ascii_punctuation());
    if token.chars().any(|c| c.is_ascii_digit()) { return true; }
    let lower = token.to_lowercase();
    if ["not", "no", "never", "don't", "didn't", "wasn't", "isn't", "can't", "won't", "nobody", "nothing"].contains(&lower.as_str()) { return true; }
    index > 0 && token.chars().next().is_some_and(char::is_uppercase)
}

/// Score one segment from its stored text, word timings and metadata.
pub fn score_segment(text: &str, start: f64, end: f64, words: &Value, metadata: &Value) -> (f64, Vec<Reason>) {
    let mut reasons = Vec::new();
    let mut push = |code: &'static str, strength: f64, detail: String| {
        let strength = clamp01(strength);
        if strength > 0.0 { reasons.push(Reason { code, detail, strength }); }
    };
    let has_text = !text.trim().is_empty();
    if let Some(logprob) = number(&metadata["avg_logprob"]) {
        // Whisper's own fallback trigger sits at -1.0.
        push("low_avg_logprob", 1.0 / (1.0 + (-((-1.0 - logprob) / 0.25)).exp()),
            format!("Average token log-probability {logprob:.2} (the recogniser retries below -1.00)"));
    }
    if let Some(no_speech) = number(&metadata["no_speech_prob"]).filter(|_| has_text) {
        push("text_where_silence_likely", no_speech,
            format!("Text was produced where the recogniser rated no-speech at {no_speech:.2}"));
    }
    if let Some(ratio) = number(&metadata["compression_ratio"]) {
        push("repetition", (ratio - 1.8) / (2.4 - 1.8),
            format!("Compression ratio {ratio:.2} suggests repeated or looping text"));
    }
    if let Some(temperature) = number(&metadata["temperature"]).filter(|t| *t > 0.0) {
        push("fallback_decoding", 0.6, format!("Decoded with fallback temperature {temperature:.1}"));
    }
    if let Some(language) = number(&metadata["language_probability"]).filter(|p| *p < 0.7) {
        push("uncertain_language", (0.7 - language) / 0.7,
            format!("Language identification confidence {language:.2}"));
    }
    let items: Vec<&Value> = words.as_array().map(|w| w.iter().collect()).unwrap_or_default();
    let scored: Vec<(usize, &str, f64)> = items.iter().enumerate()
        .filter_map(|(i, w)| number(&w["probability"]).map(|p| (i, w["word"].as_str().unwrap_or(""), p)))
        .collect();
    if !scored.is_empty() {
        let low = scored.iter().filter(|(_, _, p)| *p < 0.5).count();
        let share = low as f64 / scored.len() as f64;
        // One low word is covered by the key-word signal below; the share
        // signal needs at least two so short segments are not over-flagged.
        if low >= 2 {
            push("many_uncertain_words", share / 0.3,
                format!("{low} of {} words scored below 0.5", scored.len()));
        }
        if let Some((index, word, p)) = scored.iter().min_by(|a, b| a.2.total_cmp(&b.2)) {
            let weight = if high_stakes(word, *index) { 2.0 } else { 1.0 };
            push("uncertain_key_word", (1.0 - p - 0.5) * 2.0 * weight,
                format!("Lowest-scored word \"{}\" at {p:.2}{}", word.trim(), if weight > 1.0 { " (a number, name or negation)" } else { "" }));
        }
    }
    let duration = end - start;
    if duration >= 1.0 && !items.is_empty() {
        let rate = items.len() as f64 / duration;
        if !(0.5..=6.0).contains(&rate) {
            push("implausible_speech_rate", 0.6, format!("{rate:.1} words per second"));
        }
    }
    reasons.sort_by(|a, b| b.strength.total_cmp(&a.strength));
    let risk = reasons.first().map(|r| r.strength).unwrap_or(0.0);
    (risk, reasons)
}

/// Merge flagged segments into padded, capped clip candidates per track.
pub fn candidates_from(mut flagged: Vec<SegmentScore>) -> Vec<Candidate> {
    flagged.sort_by(|a, b| a.track.cmp(&b.track).then(a.start.total_cmp(&b.start)));
    let mut out: Vec<Candidate> = Vec::new();
    for segment in flagged {
        if let Some(last) = out.last_mut() {
            let joined_end = segment.end.max(last.end - PAD_SECONDS) + PAD_SECONDS;
            if last.track == segment.track
                && segment.start - (last.end - PAD_SECONDS) <= MERGE_GAP_SECONDS
                && joined_end - last.start <= MAX_CLIP_SECONDS
            {
                last.end = joined_end;
                last.ordinals.push(segment.ordinal);
                last.risk = last.risk.max(segment.risk);
                for reason in segment.reasons {
                    if !last.reasons.iter().any(|r| r.code == reason.code) { last.reasons.push(reason); }
                }
                continue;
            }
        }
        let start = (segment.start - PAD_SECONDS).max(0.0);
        let end = (segment.end + PAD_SECONDS).min(start + MAX_CLIP_SECONDS);
        out.push(Candidate { track: segment.track, start, end, ordinals: vec![segment.ordinal], risk: segment.risk, reasons: segment.reasons });
    }
    for candidate in &mut out {
        candidate.reasons.sort_by(|a, b| b.strength.total_cmp(&a.strength));
    }
    out
}

/// Local triage over a completed transcript run. Reads only; sends nothing.
pub fn candidates(case: &Case, source_id: &str, run_id: &str) -> Result<Value> {
    uuid::Uuid::parse_str(run_id)?;
    let source = case.source(source_id)?;
    ensure!(!source.restricted, "Transcript source is restricted");
    let (job_source, kind, status): (String, String, String) = case.db.query_row(
        "SELECT source_id,kind,status FROM processing_jobs WHERE id=?", [run_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .context("Transcript version is not available")?;
    ensure!(job_source == source_id && kind == "full_audio" && status == "complete", "Transcript version is not available");
    let mut statement = case.db.prepare(
        "SELECT ordinal,track,start_seconds,end_seconds,text,words,metadata FROM transcript_segments WHERE run_id=? ORDER BY ordinal")?;
    let mut rows = statement.query(params![run_id])?;
    let (mut total, mut flagged) = (0usize, Vec::new());
    while let Some(row) = rows.next()? {
        total += 1;
        let (ordinal, track, start, end): (i64, i64, f64, f64) = (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?);
        let text: String = row.get(4)?;
        let words = serde_json::from_str::<Value>(&row.get::<_, String>(5)?).unwrap_or(Value::Null);
        let metadata = serde_json::from_str::<Value>(&row.get::<_, String>(6)?).unwrap_or(Value::Null);
        let (risk, reasons) = score_segment(&text, start, end, &words, &metadata);
        if risk >= FLAG_THRESHOLD {
            flagged.push(SegmentScore { ordinal, track, start, end, risk, reasons });
        }
    }
    let flagged_segments = flagged.len();
    let candidates = candidates_from(flagged);
    Ok(json!({
        "source_id": source_id, "run_id": run_id,
        "segments": total, "flagged_segments": flagged_segments,
        "threshold": FLAG_THRESHOLD, "candidates": candidates,
        "note": "Heuristic flags from the local recogniser's own diagnostics. They are not accuracy scores, and an unflagged segment is not verified."
    }))
}

// ---------------------------------------------------------------------------
// Grant, clip, send and decision. Everything below runs only when a reviewer
// asks; a case without a grant can triage but never send.
// ---------------------------------------------------------------------------

use crate::case::{id, now};
use crate::providers::Provider;
use serde::Deserialize;

const GRANT_KEY: &str = "second_opinion_grant";
/// Largest clip body accepted for sending (30 s of 16 kHz mono PCM is ~1 MB).
const MAX_CLIP_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEXT: usize = 2000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Vendor { Openrouter, Openai }
impl Vendor {
    pub fn provider(self) -> Provider { match self { Vendor::Openrouter => Provider::Openrouter, Vendor::Openai => Provider::Openai } }
    pub fn endpoint(self) -> &'static str {
        match self {
            Vendor::Openrouter => "https://openrouter.ai/api/v1/chat/completions",
            Vendor::Openai => "https://api.openai.com/v1/chat/completions",
        }
    }
    /// Stated before every send; the reviewer reads it in the preview.
    pub fn disclosure(self) -> &'static str {
        match self {
            Vendor::Openrouter => "Sent through OpenRouter with zero-data-retention routing and data collection denied. The upstream provider that ran it is recorded. Cancelling may not stop billing on Google, Groq, Bedrock or Mistral upstreams.",
            Vendor::Openai => "Sent to OpenAI with your existing key. OpenAI may keep API data for up to 30 days for abuse monitoring unless your organisation has zero data retention. Cancelling may not stop billing.",
        }
    }
}

/// A per-case permission to send short audio clips to one named model. It is
/// separate from the case text and image grants, is never copied from app
/// defaults, and is refused while the case is offline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Grant { pub vendor: Vendor, pub model: String, pub revision: i64, pub granted_at: String }

pub fn grant(case: &Case) -> Result<Option<Grant>> {
    Ok(case.meta(GRANT_KEY)?.filter(|raw| !raw.is_empty()).map(|raw| serde_json::from_str(&raw)).transpose()?)
}

/// Set or revoke (None) the grant. Every change is audited and bumps the
/// revision, which invalidates previews made under an earlier grant.
pub fn set_grant(case: &mut Case, choice: Option<(Vendor, &str)>) -> Result<Option<Grant>> {
    let previous = grant(case)?;
    let revision = previous.as_ref().map(|g| g.revision).unwrap_or(0) + 1;
    let Some((vendor, model)) = choice else {
        case.set_meta(GRANT_KEY, "")?;
        case.audit("second_opinion_grant_revoked", json!({"revision": revision}))?;
        return Ok(None);
    };
    crate::providers::validate_model(model)?;
    ensure!(vendor != Vendor::Openrouter || !crate::providers::openrouter_model_is_search(model), "Web-search models are not permitted for case work");
    ensure!(!case.settings()?.offline, "Offline mode is on; turn it off before allowing a second opinion");
    let next = Grant { vendor, model: model.into(), revision, granted_at: now() };
    case.set_meta(GRANT_KEY, &serde_json::to_string(&next)?)?;
    case.audit("second_opinion_grant_changed", json!({"vendor": vendor, "model": model, "revision": revision}))?;
    Ok(Some(next))
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClipRequest { pub track: i64, pub start: f64, pub end: f64, pub ordinals: Vec<i64> }

/// Validate a clip against the transcript it came from and record a pending
/// ledger row. Returns (row id, options for processing::prepare_request).
pub fn begin_clip(case: &mut Case, source_id: &str, run_id: &str, clip: &ClipRequest) -> Result<(String, Value)> {
    let grant = grant(case)?.context("Allow a second opinion for this case in Settings first")?;
    ensure!(!case.settings()?.offline, "Offline mode is on; nothing is sent");
    let triage = candidates(case, source_id, run_id)?;
    ensure!(!clip.ordinals.is_empty() && clip.ordinals.len() <= 64, "Choose at least one flagged segment");
    ensure!(clip.start.is_finite() && clip.end.is_finite() && clip.start >= 0.0 && clip.end > clip.start && clip.end - clip.start <= MAX_CLIP_SECONDS + 1e-9, "A clip must be a positive interval no longer than 30 seconds");
    let mut reasons = Vec::new();
    for ordinal in &clip.ordinals {
        let (track, start, end): (i64, f64, f64) = case.db.query_row(
            "SELECT track,start_seconds,end_seconds FROM transcript_segments WHERE run_id=? AND ordinal=?", params![run_id, ordinal],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).context("Unknown transcript segment")?;
        ensure!(track == clip.track && start >= clip.start - PAD_SECONDS - 1e-6 && end <= clip.end + PAD_SECONDS + 1e-6, "The clip must cover the segments it names");
    }
    for candidate in triage["candidates"].as_array().into_iter().flatten() {
        if candidate["ordinals"].as_array().is_some_and(|o| o.iter().any(|v| clip.ordinals.contains(&v.as_i64().unwrap_or(-1)))) {
            reasons.extend(candidate["reasons"].as_array().cloned().unwrap_or_default());
        }
    }
    let row = id();
    case.db.execute(
        "INSERT INTO second_opinions(id,source_id,run_id,ordinals,track,start_seconds,end_seconds,vendor,model,grant_revision,status,reasons,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'clipping',?,?,?)",
        params![row, source_id, run_id, serde_json::to_string(&clip.ordinals)?, clip.track, clip.start, clip.end,
            serde_json::to_value(grant.vendor)?.as_str().unwrap_or_default(), grant.model, grant.revision, Value::Array(reasons).to_string(), now(), now()])?;
    case.audit("second_opinion_clip_requested", json!({"id": row, "source": source_id, "run": run_id, "start": clip.start, "end": clip.end, "track": clip.track}))?;
    Ok((row, json!({"operation": "media_clip", "start": clip.start, "end": clip.end, "track": clip.track})))
}

/// Attach the published clip and return the preview a reviewer confirms.
pub fn attach_clip(case: &mut Case, row: &str, published: Result<Value>) -> Result<Value> {
    let published = match published {
        Ok(value) => value,
        Err(error) => {
            case.db.execute("UPDATE second_opinions SET status='failed',error=?,updated_at=? WHERE id=? AND status='clipping'", params![error.to_string().chars().take(500).collect::<String>(), now(), row])?;
            return Err(error);
        }
    };
    // A repeated identical clip is served from the processor cache, whose
    // result names the artifact through its published locator.
    let artifact = published["artifact_id"].as_str()
        .or_else(|| published["published"][0]["artifact_id"].as_str())
        .or_else(|| published["locator"].as_str().and_then(|l| l.split("#artifact:").nth(1)))
        .or_else(|| published["published"][0]["locator"].as_str().and_then(|l| l.split("#artifact:").nth(1)))
        .context("Clip was not published")?.to_string();
    let artifact = artifact.as_str();
    let (_, mime, path, _) = crate::processing::artifact(case, artifact)?;
    ensure!(mime == "audio/wav", "Clip has an unexpected format");
    let hash: String = case.db.query_row("SELECT sha256 FROM artifacts WHERE id=?", [artifact], |r| r.get(0))?;
    let changed = case.db.execute("UPDATE second_opinions SET status='previewed',clip_artifact_id=?,clip_sha256=?,updated_at=? WHERE id=? AND status='clipping'", params![artifact, hash, now(), row])?;
    ensure!(changed == 1, "Second opinion changed before the clip was ready");
    let bytes = std::fs::metadata(path)?.len();
    preview(case, row).map(|mut value| { value["clip_bytes"] = json!(bytes); value })
}

/// What will leave the machine, to whom, and what it may cost.
pub fn preview(case: &Case, row: &str) -> Result<Value> {
    let item = entry(case, row)?;
    let vendor: Vendor = serde_json::from_value(item["vendor"].clone())?;
    let seconds = item["end"].as_f64().unwrap_or(0.0) - item["start"].as_f64().unwrap_or(0.0);
    Ok(json!({
        "second_opinion": item,
        "recipient": match vendor { Vendor::Openrouter => format!("OpenRouter → upstream provider for {}", item["model"].as_str().unwrap_or("")), Vendor::Openai => format!("OpenAI {}", item["model"].as_str().unwrap_or("")) },
        "sends": format!("{seconds:.1} seconds of 16 kHz mono audio (no file name, tags or case text) and a fixed instruction with the segment times"),
        "disclosure": vendor.disclosure(),
        "estimate": {"audio_seconds": seconds, "note": "Cost is shown after the provider reports it; no spending limit is applied."},
    }))
}

pub fn entry(case: &Case, row: &str) -> Result<Value> {
    case.db.query_row("SELECT id,source_id,run_id,ordinals,track,start_seconds,end_seconds,vendor,model,grant_revision,status,clip_artifact_id,clip_sha256,reasons,result,usage,error,decision,created_at,updated_at FROM second_opinions WHERE id=?", [row], |r| Ok(json!({
        "id": r.get::<_, String>(0)?, "source_id": r.get::<_, String>(1)?, "run_id": r.get::<_, String>(2)?,
        "ordinals": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(Value::Null),
        "track": r.get::<_, i64>(4)?, "start": r.get::<_, f64>(5)?, "end": r.get::<_, f64>(6)?,
        "vendor": r.get::<_, String>(7)?, "model": r.get::<_, String>(8)?, "grant_revision": r.get::<_, i64>(9)?,
        "status": r.get::<_, String>(10)?, "clip_artifact_id": r.get::<_, Option<String>>(11)?, "clip_sha256": r.get::<_, Option<String>>(12)?,
        "reasons": serde_json::from_str::<Value>(&r.get::<_, String>(13)?).unwrap_or(Value::Null),
        "result": r.get::<_, Option<String>>(14)?.and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "usage": r.get::<_, Option<String>>(15)?.and_then(|v| serde_json::from_str::<Value>(&v).ok()),
        "error": r.get::<_, String>(16)?, "decision": r.get::<_, Option<String>>(17)?,
        "created_at": r.get::<_, String>(18)?, "updated_at": r.get::<_, String>(19)?,
        "label": "Unreviewed remote machine interpretation"
    }))).context("Second opinion not found")
}

pub fn list(case: &Case, source_id: &str) -> Result<Value> {
    let mut statement = case.db.prepare("SELECT id FROM second_opinions WHERE source_id=? ORDER BY created_at DESC LIMIT 100")?;
    let ids = statement.query_map([source_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Value::Array(ids.iter().map(|row| entry(case, row)).collect::<Result<Vec<_>>>()?))
}

/// Everything the desktop layer needs to send, prepared under the case lock.
pub struct Outbound { pub row: String, pub vendor: Vendor, pub body: Value, pub transmission: String }

const INSTRUCTION: &str = "You are giving a second opinion on a short audio clip from legal evidence. Transcribe only what is audible in each listed time range (seconds from the start of this clip). Do not guess: write [inaudible] for words you cannot make out, and do not add speaker names. Reply with JSON only: {\"segments\":[{\"ordinal\":<number>,\"text\":\"...\"}],\"notes\":\"one short sentence on audio quality or uncertainty\"}.";

pub fn request_body(vendor: Vendor, model: &str, wav: &[u8], windows: &[(i64, f64, f64)]) -> Value {
    use base64::Engine;
    let ranges = windows.iter().map(|(o, a, b)| format!("ordinal {o}: {a:.2}–{b:.2} s")).collect::<Vec<_>>().join("; ");
    let mut body = json!({
        "model": model,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": INSTRUCTION},
            {"role": "user", "content": [
                {"type": "text", "text": format!("Time ranges: {ranges}.")},
                {"type": "input_audio", "input_audio": {"data": base64::engine::general_purpose::STANDARD.encode(wav), "format": "wav"}}
            ]}
        ]
    });
    if vendor == Vendor::Openrouter {
        body["provider"] = json!({"zdr": true, "data_collection": "deny"});
    }
    body
}

/// Re-check everything at send time (grant revision, offline, restriction,
/// strong clip hash), then open a ledger anchor and a pending transmission.
pub fn prepare_send(case: &mut Case, row: &str) -> Result<Outbound> {
    let item = entry(case, row)?;
    ensure!(item["status"] == "previewed", "Only a previewed clip can be sent, once");
    let grant = grant(case)?.context("The second-opinion permission was revoked")?;
    ensure!(item["grant_revision"].as_i64() == Some(grant.revision) && item["vendor"] == json!(grant.vendor) && item["model"] == grant.model.as_str(), "The permission changed since this preview; prepare a new preview");
    ensure!(!case.settings()?.offline, "Offline mode is on; nothing is sent");
    let source_id = item["source_id"].as_str().context("Missing source")?;
    ensure!(!case.source(source_id)?.restricted, "Restricted sources are never sent");
    let artifact = item["clip_artifact_id"].as_str().context("Clip missing")?;
    let (_, mime, path, _) = crate::processing::artifact(case, artifact)?;
    ensure!(mime == "audio/wav" && std::fs::metadata(&path)?.len() <= MAX_CLIP_BYTES, "Clip is missing or too large");
    let wav = std::fs::read(&path)?;
    ensure!(crate::case::digest(&wav) == item["clip_sha256"].as_str().unwrap_or(""), "Clip changed since the preview");
    let start = item["start"].as_f64().unwrap_or(0.0);
    let run = item["run_id"].as_str().unwrap_or_default().to_string();
    let mut windows = Vec::new();
    for ordinal in item["ordinals"].as_array().into_iter().flatten().filter_map(Value::as_i64) {
        let (a, b): (f64, f64) = case.db.query_row("SELECT start_seconds,end_seconds FROM transcript_segments WHERE run_id=? AND ordinal=?", params![run, ordinal], |r| Ok((r.get(0)?, r.get(1)?)))?;
        windows.push((ordinal, (a - start).max(0.0), (b - start).max(0.0)));
    }
    let body = request_body(grant.vendor, &grant.model, &wav, &windows);
    let task = id();
    let transmission = id();
    case.db.execute_batch("SAVEPOINT second_opinion_send")?;
    let opened = (|| -> Result<()> {
        // A ledger anchor so the existing usage totals include this request;
        // mode 'second_opinion' keeps it out of chat lists and resume paths.
        let generation: i64 = case.meta("generation")?.and_then(|v| v.parse().ok()).unwrap_or(0);
        case.db.execute("INSERT INTO tasks(id,prompt,mode,status,scope,edit_scope,budget,generation,created_at,updated_at) VALUES(?,?,'second_opinion','complete',?,'[]',0,?,?,?)",
            params![task, format!("Second opinion on {} clip", source_id), json!([source_id]).to_string(), generation, now(), now()])?;
        case.db.execute("INSERT INTO transmissions(id,task_id,payload_hash,model,source_ids,reserved,status,created_at) VALUES(?,?,?,?,?,0,'pending',?)",
            params![transmission, task, crate::case::digest(body.to_string().as_bytes()), format!("{}:{}", grant.vendor.provider().name(), grant.model), json!([source_id]).to_string(), now()])?;
        case.db.execute("UPDATE second_opinions SET status='sending',task_id=?,transmission_id=?,updated_at=? WHERE id=? AND status='previewed'", params![task, transmission, now(), row])?;
        case.audit("second_opinion_sent", json!({"id": row, "vendor": grant.vendor, "model": grant.model, "clip_sha256": item["clip_sha256"], "payload_sha256": crate::case::digest(body.to_string().as_bytes()), "transmission": transmission}))?;
        Ok(())
    })();
    if opened.is_err() { case.db.execute_batch("ROLLBACK TO second_opinion_send")?; }
    case.db.execute_batch("RELEASE second_opinion_send")?;
    opened?;
    Ok(Outbound { row: row.into(), vendor: grant.vendor, body, transmission })
}

/// Parse a chat-completions reply into bounded per-segment text. Unparseable
/// replies keep a bounded raw note so nothing is silently discarded.
pub fn interpret(response: &Value, ordinals: &[i64]) -> Value {
    let content = response["choices"][0]["message"]["content"].as_str().unwrap_or("");
    let trimmed = content.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let parsed = serde_json::from_str::<Value>(trimmed).ok();
    let segments: Vec<Value> = parsed.as_ref().and_then(|v| v["segments"].as_array()).into_iter().flatten()
        .filter_map(|s| {
            let ordinal = s["ordinal"].as_i64().filter(|o| ordinals.contains(o))?;
            let text = s["text"].as_str()?.chars().take(MAX_TEXT).collect::<String>();
            (!text.trim().is_empty()).then(|| json!({"ordinal": ordinal, "text": text}))
        }).collect();
    let notes = parsed.as_ref().and_then(|v| v["notes"].as_str()).unwrap_or("").chars().take(500).collect::<String>();
    json!({"segments": segments, "notes": notes, "raw": if segments.is_empty() { json!(content.chars().take(4000).collect::<String>()) } else { Value::Null },
           "label": "Unreviewed remote machine interpretation. Model timestamps and text can be wrong; check against the original audio."})
}

/// Record the outcome of a send. Remote text is stored only in this ledger;
/// it never changes the transcript until a reviewer decides.
pub fn finish_send(case: &mut Case, outbound: &Outbound, outcome: Result<Value>) -> Result<Value> {
    let item = entry(case, &outbound.row)?;
    ensure!(item["status"] == "sending", "Second opinion changed while sending");
    match outcome {
        Ok(response) => {
            let ordinals: Vec<i64> = item["ordinals"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect();
            let result = interpret(&response, &ordinals);
            let usage = json!({"input_tokens": response["usage"]["prompt_tokens"], "output_tokens": response["usage"]["completion_tokens"],
                "cost": response["usage"]["cost"].as_f64().filter(|c| c.is_finite() && *c >= 0.0), "upstream_provider": response["provider"].as_str(), "generation_id": response["id"].as_str()});
            case.db.execute("UPDATE transmissions SET status='received',usage=?,actual=? WHERE id=? AND status='pending'", params![usage.to_string(), usage["cost"].as_f64(), outbound.transmission])?;
            case.db.execute("UPDATE second_opinions SET status='received',result=?,usage=?,updated_at=? WHERE id=?", params![result.to_string(), usage.to_string(), now(), outbound.row])?;
            case.audit("second_opinion_received", json!({"id": outbound.row, "segments": result["segments"].as_array().map(Vec::len)}))?;
        }
        Err(error) => {
            let cancelled = error.to_string().contains("cancelled");
            case.db.execute("UPDATE transmissions SET status='uncertain' WHERE id=? AND status='pending'", [&outbound.transmission])?;
            case.db.execute("UPDATE second_opinions SET status=?,error=?,updated_at=? WHERE id=?", params![if cancelled { "cancelled" } else { "uncertain" }, error.to_string().chars().take(500).collect::<String>(), now(), outbound.row])?;
            case.audit("second_opinion_failed", json!({"id": outbound.row, "cancelled": cancelled}))?;
        }
    }
    entry(case, &outbound.row)
}

/// A reviewer's decision. Accepting or editing creates human-attributed,
/// accepted transcript corrections that cite the model; the machine
/// transcript itself is never changed.
pub fn decide(case: &mut Case, row: &str, decision: &str, edits: &[(i64, String)]) -> Result<Value> {
    let item = entry(case, row)?;
    ensure!(item["decision"].is_null(), "A decision was already recorded");
    ensure!(["accepted_remote", "kept_local", "edited", "unresolved"].contains(&decision), "Unknown decision");
    let source = item["source_id"].as_str().unwrap_or_default().to_string();
    let run = item["run_id"].as_str().unwrap_or_default().to_string();
    let ordinals: Vec<i64> = item["ordinals"].as_array().into_iter().flatten().filter_map(Value::as_i64).collect();
    let texts: Vec<(i64, String)> = match decision {
        "accepted_remote" => {
            ensure!(item["status"] == "received", "There is no received second opinion to accept");
            item["result"]["segments"].as_array().into_iter().flatten()
                .filter_map(|s| Some((s["ordinal"].as_i64()?, s["text"].as_str()?.to_string()))).collect()
        }
        "edited" => { ensure!(edits.iter().all(|(o, t)| ordinals.contains(o) && !t.trim().is_empty() && t.len() <= 10000), "Edits must name this clip's segments"); edits.to_vec() }
        _ => Vec::new(),
    };
    ensure!(decision != "accepted_remote" || !texts.is_empty(), "The second opinion returned no segment text to accept");
    let reason = format!("Reviewer decision on a second opinion from {} {} (unreviewed machine interpretation, checked against the audio)", item["vendor"].as_str().unwrap_or(""), item["model"].as_str().unwrap_or(""));
    let mut corrections = Vec::new();
    for (ordinal, text) in texts {
        let saved = crate::transcription::save_correction(case, &source, &run, ordinal, &text, &reason)?;
        let id = saved["id"].as_str().context("Correction id missing")?.to_string();
        crate::transcription::review_correction(case, &id, true)?;
        corrections.push(json!({"ordinal": ordinal, "correction": id}));
    }
    case.db.execute("UPDATE second_opinions SET decision=?,updated_at=? WHERE id=? AND decision IS NULL", params![decision, now(), row])?;
    case.audit("second_opinion_decided", json!({"id": row, "decision": decision, "corrections": corrections}))?;
    Ok(json!({"second_opinion": entry(case, row)?, "corrections": corrections}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[(&str, f64)]) -> Value {
        Value::Array(list.iter().enumerate().map(|(i, (w, p))| json!({"word": w, "probability": p, "start": i as f64 * 0.4, "end": i as f64 * 0.4 + 0.3})).collect())
    }

    #[test]
    fn confident_speech_is_not_flagged() {
        let meta = json!({"avg_logprob": -0.2, "no_speech_prob": 0.01, "compression_ratio": 1.3, "temperature": 0.0, "language_probability": 0.99});
        let (risk, reasons) = score_segment("Meet at the north door", 0.0, 2.0, &words(&[(" Meet", 0.98), (" at", 0.97), (" the", 0.99), (" north", 0.95), (" door", 0.96)]), &meta);
        assert!(risk < FLAG_THRESHOLD, "{risk} {reasons:?}");
    }

    #[test]
    fn each_signal_can_flag_a_segment_with_a_stated_reason() {
        let base = json!({"avg_logprob": -0.2, "no_speech_prob": 0.01, "compression_ratio": 1.3, "temperature": 0.0, "language_probability": 0.99});
        let good = words(&[(" one", 0.99), (" two", 0.99), (" three", 0.99), (" four", 0.99)]);
        let cases: Vec<(&str, Value, Value)> = vec![
            ("low_avg_logprob", json!({"avg_logprob": -1.4}), good.clone()),
            ("text_where_silence_likely", json!({"no_speech_prob": 0.8}), good.clone()),
            ("repetition", json!({"compression_ratio": 2.6}), good.clone()),
            ("fallback_decoding", json!({"temperature": 0.4}), good.clone()),
            ("uncertain_language", json!({"language_probability": 0.2}), good.clone()),
            ("uncertain_key_word", json!({}), words(&[(" paid", 0.99), (" 4,500", 0.3), (" dollars", 0.99), (" today", 0.99)])),
        ];
        for (code, patch, word_list) in cases {
            let mut meta = base.clone();
            for (k, v) in patch.as_object().unwrap() { meta[k] = v.clone(); }
            let (risk, reasons) = score_segment("synthetic words", 0.0, 2.0, &word_list, &meta);
            assert!(risk >= FLAG_THRESHOLD, "{code}: {risk}");
            assert_eq!(reasons[0].code, code, "{reasons:?}");
            assert!(!reasons[0].detail.contains('%'), "diagnostics are never percentages");
        }
    }

    #[test]
    fn a_number_weighs_more_than_an_ordinary_word() {
        let meta = json!({});
        let key = |list: &[(&str, f64)]| score_segment("x", 0.0, 2.0, &words(list), &meta).1.into_iter().find(|r| r.code == "uncertain_key_word").map(|r| r.strength).unwrap_or(0.0);
        assert!(key(&[(" the", 0.99), (" 42", 0.4), (" ran", 0.99)]) > key(&[(" the", 0.99), (" dog", 0.4), (" ran", 0.99)]));
        assert!(key(&[(" she", 0.99), (" did", 0.99), (" not", 0.4)]) > key(&[(" she", 0.99), (" did", 0.99), (" go", 0.4)]));
    }

    #[test]
    fn missing_or_invalid_signals_are_ignored() {
        let (risk, reasons) = score_segment("text", 0.0, 1.0, &Value::Null, &json!({"avg_logprob": null, "no_speech_prob": "x"}));
        assert_eq!(risk, 0.0);
        assert!(reasons.is_empty());
    }

    fn flagged(ordinal: i64, track: i64, start: f64, end: f64) -> SegmentScore {
        SegmentScore { ordinal, track, start, end, risk: 0.7, reasons: vec![Reason { code: "low_avg_logprob", detail: String::new(), strength: 0.7 }] }
    }

    #[test]
    fn nearby_segments_merge_into_padded_clips_capped_at_thirty_seconds() {
        let out = candidates_from(vec![flagged(0, 0, 10.0, 12.0), flagged(1, 0, 13.0, 15.0), flagged(2, 0, 20.0, 22.0), flagged(3, 1, 13.5, 14.0)]);
        assert_eq!(out.len(), 3);
        assert_eq!((out[0].start, out[0].end, out[0].ordinals.clone()), (9.5, 15.5, vec![0, 1]));
        assert_eq!((out[1].start, out[1].end), (19.5, 22.5));
        assert_eq!(out[2].track, 1, "tracks are never merged");
        // A long run is split so no clip exceeds the cap.
        let run: Vec<_> = (0..20).map(|i| flagged(i, 0, i as f64 * 2.5, i as f64 * 2.5 + 2.0)).collect();
        let clips = candidates_from(run);
        assert!(clips.len() > 1);
        assert!(clips.iter().all(|c| c.end - c.start <= MAX_CLIP_SECONDS + 1e-9), "{clips:?}");
        assert_eq!(candidates_from(vec![flagged(0, 0, 0.2, 1.0)])[0].start, 0.0, "padding never goes before zero");
    }
}
