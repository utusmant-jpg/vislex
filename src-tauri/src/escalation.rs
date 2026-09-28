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
