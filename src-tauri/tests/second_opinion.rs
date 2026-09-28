//! Second opinion on uncertain audio: the full ledger flow without network.
//! Sending is simulated by handing finish_send a synthetic provider reply.
use evidence_desk::{case::Case, escalation, processing, transcription};
use serde_json::{json, Value};
use std::{fs, path::Path};

struct Fixture { _dir: tempfile::TempDir, case: Case, source: String, run: String }

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let input = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/generated/variable-timing.mp4");
    let mut case = Case::create(&dir.path().join("case.ledcase"), "Synthetic second opinion").unwrap();
    case.import_files(&[input.to_string_lossy().into()], "Synthetic fixture").unwrap();
    case.save_settings(evidence_desk::case::Settings { offline: false, allow_text: true, allow_images: false, model: "synthetic".into() }).unwrap();
    let source = case.sources().unwrap().into_iter().find(|s| s.kind == "video").unwrap().id;
    let job = transcription::begin(&mut case, &source).unwrap();
    let doubtful = json!([{"word":" Paid","probability":0.9,"start":5.0,"end":5.4},{"word":" 4,500","probability":0.2,"start":5.4,"end":6.0},{"word":" today","probability":0.9,"start":6.0,"end":6.5}]);
    let pages = json!([
        {"start":0.0,"end":1.0,"track":1,"text":"Open the door","words":[],"avg_logprob":-0.1},
        {"start":5.0,"end":6.5,"track":1,"text":"Paid 4,500 today","words":doubtful,"avg_logprob":-0.9}
    ]);
    let staged = transcription::stage_transcript(&job, json!({"pages":pages,"metadata":{},"limitations":[]})).unwrap();
    transcription::publish_staged_transcript(&mut case, &job, staged).unwrap();
    Fixture { _dir: dir, case, source, run: job.id }
}

/// Stand-in for the sandboxed clip worker: publish a small WAV the same way.
fn publish_clip(case: &mut Case, source: &str, options: Value) -> anyhow::Result<Value> {
    let job = processing::prepare_request(case, source, options)?;
    if job.cached.is_some() {
        // An identical clip is served from the processor cache, as in production.
        let staged = processing::stage_prepared(&job, processing::run_prepared(&job));
        return processing::publish_staged(case, &job, staged);
    }
    fs::write(job.staging.path().join("clip.wav"), b"RIFF synthetic pcm").unwrap();
    let staged = processing::stage_prepared(&job, Ok(json!({"pages":[],"metadata":{},"previews":[{"path":"clip.wav","mime":"audio/wav"}]})));
    processing::publish_staged(case, &job, staged)
}

fn request() -> escalation::ClipRequest {
    serde_json::from_value(json!({"track":1,"start":4.5,"end":7.0,"ordinals":[1]})).unwrap()
}

#[test]
fn nothing_can_be_clipped_or_sent_without_the_case_grant() {
    let mut f = fixture();
    let error = escalation::begin_clip(&mut f.case, &f.source, &f.run, &request()).unwrap_err().to_string();
    assert!(error.contains("Allow a second opinion"), "{error}");
    assert!(escalation::set_grant(&mut f.case, Some((escalation::Vendor::Openrouter, "perplexity/sonar"))).is_err(), "search models are refused");
    let mut settings = f.case.settings().unwrap(); settings.offline = true; f.case.save_settings(settings).unwrap();
    assert!(escalation::set_grant(&mut f.case, Some((escalation::Vendor::Openrouter, "google/gemini-2.5-flash"))).is_err(), "offline refuses a grant");
}

#[test]
fn a_confirmed_second_opinion_is_recorded_and_only_a_reviewer_changes_the_transcript() {
    let mut f = fixture();
    let grant = escalation::set_grant(&mut f.case, Some((escalation::Vendor::Openrouter, "google/gemini-2.5-flash"))).unwrap().unwrap();
    assert_eq!(grant.revision, 1);
    let (row, options) = escalation::begin_clip(&mut f.case, &f.source, &f.run, &request()).unwrap();
    let published = publish_clip(&mut f.case, &f.source, options);
    let preview = escalation::attach_clip(&mut f.case, &row, published).unwrap();
    assert_eq!(preview["second_opinion"]["status"], "previewed");
    assert!(preview["disclosure"].as_str().unwrap().contains("Cancelling may not stop billing"));
    assert!(preview["sends"].as_str().unwrap().contains("no file name"));

    let outbound = escalation::prepare_send(&mut f.case, &row).unwrap();
    let audio = &outbound.body["messages"][1]["content"][1];
    assert_eq!(audio["type"], "input_audio");
    assert_eq!(audio["input_audio"]["format"], "wav");
    assert_eq!(outbound.body["provider"], json!({"zdr":true,"data_collection":"deny"}));
    let body = outbound.body.to_string();
    assert!(!body.contains("Paid 4,500"), "no case text is sent, only the audio and segment times");
    assert!(!body.contains(&f.source), "no case identifiers are sent");
    assert!(escalation::prepare_send(&mut f.case, &row).is_err(), "a preview is single-use");
    assert_eq!(f.case.task_page(None).unwrap()["tasks"].as_array().unwrap().len(), 0, "the ledger anchor is not a chat");

    let reply = json!({"id":"gen-synthetic","provider":"SyntheticUpstream","choices":[{"message":{"content":"```json\n{\"segments\":[{\"ordinal\":1,\"text\":\"Paid 4,800 today\"},{\"ordinal\":9,\"text\":\"not in this clip\"}],\"notes\":\"Faint.\"}\n```"}}],"usage":{"prompt_tokens":90,"completion_tokens":20,"cost":0.0012}});
    let received = escalation::finish_send(&mut f.case, &outbound, Ok(reply)).unwrap();
    assert_eq!(received["status"], "received");
    assert_eq!(received["result"]["segments"], json!([{"ordinal":1,"text":"Paid 4,800 today"}]), "ordinals outside the clip are dropped");
    let (status, actual): (String, Option<f64>) = f.case.db.query_row("SELECT status,actual FROM transmissions WHERE id=?", [&outbound.transmission], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((status.as_str(), actual), ("received", Some(0.0012)));
    // Receiving changes nothing in the transcript.
    let page = transcription::segment_page(&f.case, &f.source, &f.run, None).unwrap();
    assert!(page["segments"][1]["correction"].is_null());

    let decided = escalation::decide(&mut f.case, &row, "accepted_remote", &[]).unwrap();
    assert_eq!(decided["second_opinion"]["decision"], "accepted_remote");
    let page = transcription::segment_page(&f.case, &f.source, &f.run, None).unwrap();
    assert_eq!(page["segments"][1]["correction"]["text"], "Paid 4,800 today");
    assert_eq!(page["segments"][1]["correction"]["review"], "accepted");
    assert_eq!(page["segments"][1]["text"], "Paid 4,500 today", "the machine transcript is never rewritten");
    assert!(escalation::decide(&mut f.case, &row, "kept_local", &[]).is_err(), "one decision per second opinion");
}

#[test]
fn changing_the_grant_or_restricting_the_source_blocks_a_prepared_send() {
    let mut f = fixture();
    escalation::set_grant(&mut f.case, Some((escalation::Vendor::Openai, "gpt-4o-audio-preview"))).unwrap();
    let (row, options) = escalation::begin_clip(&mut f.case, &f.source, &f.run, &request()).unwrap();
    let published = publish_clip(&mut f.case, &f.source, options);
    escalation::attach_clip(&mut f.case, &row, published).unwrap();
    escalation::set_grant(&mut f.case, Some((escalation::Vendor::Openai, "gpt-4o-audio-preview"))).unwrap();
    let error = escalation::prepare_send(&mut f.case, &row).err().unwrap().to_string();
    assert!(error.contains("permission changed"), "{error}");

    let (row, options) = escalation::begin_clip(&mut f.case, &f.source, &f.run, &request()).unwrap();
    let published = publish_clip(&mut f.case, &f.source, options);
    escalation::attach_clip(&mut f.case, &row, published).unwrap();
    f.case.set_restricted(&f.source, true).unwrap();
    assert!(escalation::prepare_send(&mut f.case, &row).is_err(), "restricted sources are never sent");
    f.case.set_restricted(&f.source, false).unwrap();
    escalation::set_grant(&mut f.case, None).unwrap();
    assert!(escalation::prepare_send(&mut f.case, &row).is_err(), "revoking the grant blocks sending");
}

#[test]
fn a_failed_or_cancelled_send_is_recorded_as_uncertain_and_can_be_left_unresolved() {
    let mut f = fixture();
    escalation::set_grant(&mut f.case, Some((escalation::Vendor::Openrouter, "google/gemini-2.5-flash"))).unwrap();
    let (row, options) = escalation::begin_clip(&mut f.case, &f.source, &f.run, &request()).unwrap();
    let published = publish_clip(&mut f.case, &f.source, options);
    escalation::attach_clip(&mut f.case, &row, published).unwrap();
    let outbound = escalation::prepare_send(&mut f.case, &row).unwrap();
    let recorded = escalation::finish_send(&mut f.case, &outbound, Err(anyhow::anyhow!("Request cancelled; transmission may have occurred"))).unwrap();
    assert_eq!(recorded["status"], "cancelled");
    let status: String = f.case.db.query_row("SELECT status FROM transmissions WHERE id=?", [&outbound.transmission], |r| r.get(0)).unwrap();
    assert_eq!(status, "uncertain");
    assert!(escalation::decide(&mut f.case, &row, "accepted_remote", &[]).is_err());
    escalation::decide(&mut f.case, &row, "unresolved", &[]).unwrap();
}
