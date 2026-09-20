//! Offline receipt replay. Copies the database into a disposable case and never sends API requests.
use anyhow::{Context, Result};
use evidence_desk::{agent, case::Case, review_progress};
use rusqlite::{Connection, DatabaseName, OpenFlags};
use serde_json::json;

fn main() -> Result<()> {
    let mut args=std::env::args().skip(1);
    let database=args.next().context("Usage: replay-review <case.sqlite3> <task-id>")?;
    let task=args.next().context("Missing task receipt id")?;
    let original=Connection::open_with_flags(database,OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let temp=tempfile::tempdir()?;
    let root=temp.path().join("offline-replay.ledcase");
    drop(Case::create(&root,"Offline receipt replay")?);
    original.backup(DatabaseName::Main,root.join("case.sqlite3"),None)?;
    drop(original);
    let mut case=Case::open(&root)?;
    let (status,steps):(String,i64)=case.db.query_row("SELECT status,step FROM tasks WHERE id=?",[&task],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if status=="paused" {agent::resume(&mut case,&task)?;}
    let first=agent::prepare_request(&mut case,&task)?;
    anyhow::ensure!(first.body["tool_choice"]["name"]=="checkpoint_review","Recovery did not request a progress checkpoint");
    let first_bytes=first.body["input"].to_string().len();
    // A deterministic diagnostic placeholder, not an AI-generated evidentiary answer.
    let checkpoint=json!({"summary":"Offline diagnostic: prior receipts remain available. No new substantive findings were synthesized by this replay.","citations":[],"gaps":["Visual review remains outstanding"],"next_steps":["Inspect relevant frames, then synthesize cited findings"]});
    let simulated=json!({"status":"completed","usage":{"input_tokens":0,"output_tokens":0},"output":[{"type":"function_call","call_id":"offline-diagnostic-checkpoint","name":"checkpoint_review","arguments":checkpoint.to_string()}]});
    anyhow::ensure!(agent::receive(&mut case,&task,&first.transmission,simulated)?,"Checkpoint prematurely finished task");
    let next=agent::prepare_request(&mut case,&task)?;
    anyhow::ensure!(next.body["tool_choice"]["name"]=="inspect_video_interval","Recovery did not advance to missing visual evidence");
    let ids=case.sources()?.into_iter().map(|s|s.id).collect::<Vec<_>>();
    let ledger=review_progress::ledger(&case,&task,&ids)?;
    let sources=ledger["sources"].as_array().context("Missing ledger sources")?;
    println!("{}",serde_json::to_string_pretty(&json!({
        "receipt":task,"original_steps":steps,"original_status":status,
        "first_recovery_tool":first.body["tool_choice"]["name"],
        "next_tool":next.body["tool_choice"]["name"],
        "sources_preserved":sources.len(),
        "distinct_read_ranges_preserved":sources.iter().map(|s|s["reads"].as_array().map_or(0,Vec::len)).sum::<usize>(),
        "input_bytes_before_checkpoint":first_bytes,"input_bytes_after_diagnostic_checkpoint":next.body["input"].to_string().len(),
        "provider_requests_sent":0,"original_database_modified":false,
        "limitation":"Deterministic control-flow replay with a placeholder checkpoint; not a live model-quality or cost benchmark."
    }))?);
    Ok(())
}
