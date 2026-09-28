use evidence_desk::{case::{Case,digest},semantic};
use serde_json::json;
use std::{fs,time::Instant};

#[test]
fn chat_query_uses_saved_index_and_returns_lexical_leads_without_indexing() {
    let dir=tempfile::tempdir().unwrap();
    let input=dir.path().join("note.txt");
    fs::write(&input,"The blue folder was beside the east door.\n").unwrap();
    let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic search").unwrap();
    case.import_files(&[input.to_string_lossy().into()],"Synthetic fixture").unwrap();
    let source=case.sources().unwrap()[0].id.clone();
    let job=semantic::prepare_query(&case,"blue folder",vec![source.clone()]).unwrap();
    let request:serde_json::Value=serde_json::from_slice(&fs::read(job.staging.path().join("request.json")).unwrap()).unwrap();
    assert_eq!(request["texts"].as_array().unwrap().len(),1);
    let result=semantic::publish(&mut case,&job,json!({"vectors":[vec![0.05_f64;384]]})).unwrap();
    assert_eq!(result["indexed_passages"],0);
    assert_eq!(result["lexical_results"][0]["source_id"],source);
    assert_eq!(result["index_currentness"],"saved_index_may_be_partial");
    assert_eq!(semantic::lexical_results(&case,"east door",&[source.clone()]).unwrap()[0]["locator"],format!("evidence:{source}#R1L1-L1"));
    assert!(semantic::prepare_background(&case,vec![source]).unwrap().is_some());
}

#[test]
fn background_index_batches_are_durable_and_revision_scoped() {
    let dir=tempfile::tempdir().unwrap();
    let input=dir.path().join("transcript.txt");
    let text=(0..300).map(|index|format!("Line {index} contains a blue folder.\n")).collect::<String>();
    fs::write(&input,&text).unwrap();
    let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic background indexing").unwrap();
    case.import_files(&[input.to_string_lossy().into()],"Synthetic fixture").unwrap();
    let source=case.sources().unwrap()[0].id.clone();
    let first=semantic::prepare_background(&case,vec![source.clone()]).unwrap().unwrap();
    let request:serde_json::Value=serde_json::from_slice(&fs::read(first.staging.path().join("request.json")).unwrap()).unwrap();
    assert_eq!(request["scheduler_priority"],"background");
    assert_eq!(request["texts"].as_array().unwrap().len(),257);
    let vectors=vec![vec![0.05_f64;384];257];
    assert_eq!(semantic::publish_index(&mut case,&first,&json!({"vectors":vectors,"truncated":vec![false;257]})).unwrap(),44);
    let second=semantic::prepare_background(&case,vec![source.clone()]).unwrap().unwrap();
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(second.staging.path().join("request.json")).unwrap()).unwrap()["texts"].as_array().unwrap().len(),45);
    assert_eq!(semantic::publish_index(&mut case,&second,&json!({"vectors":vec![vec![0.05_f64;384];45],"truncated":vec![false;45]})).unwrap(),0);
    assert!(semantic::prepare_background(&case,vec![source.clone()]).unwrap().is_none());
    case.publish_extract(&source,"A new revision includes the red folder.","Synthetic revision",true).unwrap();
    assert!(semantic::prepare_background(&case,vec![source]).unwrap().is_some());
}

#[test]
#[ignore]
fn semantic_prepare_scans_every_line_before_bounding_the_worker_batch() {
    let dir=tempfile::tempdir().unwrap();
    let input=dir.path().join("long-transcript.txt");
    let text=(0..5000).map(|index|format!("[{index:05}] Witness reports a blue case near the east entrance.\n")).collect::<String>();
    fs::write(&input,&text).unwrap();
    let mut case=Case::create(&dir.path().join("case.ledcase"),"Synthetic semantic baseline").unwrap();
    case.import_files(&[input.to_string_lossy().into()],"Synthetic fixture").unwrap();
    let source=case.sources().unwrap()[0].id.clone();
    let mut samples=Vec::new();
    let mut lexical_samples=Vec::new();
    for _ in 0..5 {
        let start=Instant::now();
        let hits=semantic::lexical_results(&case,"blue case",&[source.clone()]).unwrap();
        assert_eq!(hits.len(),1);
        lexical_samples.push(start.elapsed().as_millis());
    }
    lexical_samples.sort();
    eprintln!("lexical_5000_lines_ms p50={} p95={} all={lexical_samples:?}",lexical_samples[2],lexical_samples[4]);
    let start=Instant::now();
    let last=semantic::lexical_results(&case,"[04999]",&[source.clone()]).unwrap();
    assert_eq!(last[0]["locator"],format!("evidence:{source}#R1L5000-L5000"));
    eprintln!("lexical_5000_lines_last_hit_ms={}",start.elapsed().as_millis());
    for _ in 0..5 {
        let start=Instant::now();
        let job=semantic::prepare(&case,"blue case",vec![source.clone()]).unwrap();
        samples.push(start.elapsed().as_millis());
        drop(job);
    }
    samples.sort();
    eprintln!("semantic_prepare_5000_lines_ms p50={} p95={} all={samples:?}",samples[2],samples[4]);
    let vector=json!(vec![0.05_f64;384]).to_string();
    case.db.execute_batch("BEGIN").unwrap();
    for (index,line) in text.lines().enumerate() {
        case.db.execute("INSERT INTO semantic_passages VALUES(?,1,?,?,?,?,?,0)",rusqlite::params![source,index+1,digest(line.as_bytes()),line,vector,"minilm-1110a243-quint8-avx2-mean256"]).unwrap();
    }
    case.db.execute_batch("COMMIT").unwrap();
    let mut ranking=Vec::new();
    for _ in 0..5 {
        let job=semantic::prepare(&case,"blue case",vec![source.clone()]).unwrap();
        let start=Instant::now();
        let result=semantic::publish(&mut case,&job,json!({"vectors":[vec![0.05_f64;384]],"truncated":[false]})).unwrap();
        assert_eq!(result["indexed_passages"],5000);
        ranking.push(start.elapsed().as_millis());
    }
    ranking.sort();
    eprintln!("semantic_rank_5000_json_vectors_ms p50={} p95={} all={ranking:?}",ranking[2],ranking[4]);
    let packed=(0..384).flat_map(|_|0.05_f32.to_le_bytes()).collect::<Vec<_>>();
    case.db.execute("UPDATE semantic_passages SET vector=?",[packed]).unwrap();
    let mut packed_ranking=Vec::new();
    for _ in 0..5 {
        let job=semantic::prepare(&case,"blue case",vec![source.clone()]).unwrap();
        let start=Instant::now();
        let result=semantic::publish(&mut case,&job,json!({"vectors":[vec![0.05_f64;384]],"truncated":[false]})).unwrap();
        assert_eq!(result["indexed_passages"],5000);
        packed_ranking.push(start.elapsed().as_millis());
    }
    packed_ranking.sort();
    eprintln!("semantic_rank_5000_packed_vectors_ms p50={} p95={} all={packed_ranking:?}",packed_ranking[2],packed_ranking[4]);
}
