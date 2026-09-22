//! Rebuildable local vectors, exact extraction revisions, and rank fusion with lexical matching.
use crate::case::{Case,digest};
use anyhow::{ensure,Context,Result};
use rusqlite::params;
use serde_json::{json,Value};
const MODEL:&str="minilm-1110a243-quint8-avx2-mean256";
#[derive(Clone)]
pub struct Passage {source:String,revision:i64,line:u64,text:String,hash:String}
pub struct SearchJob {pub staging:tempfile::TempDir,query:String,scope:Vec<String>,passages:Vec<Passage>,pending:usize}
fn schema(case:&Case)->Result<()> {case.db.execute_batch("CREATE TABLE IF NOT EXISTS semantic_passages(source_id TEXT NOT NULL,revision INTEGER NOT NULL,line INTEGER NOT NULL,text_hash TEXT NOT NULL,text TEXT NOT NULL,vector TEXT NOT NULL,model TEXT NOT NULL,truncated INTEGER NOT NULL,PRIMARY KEY(source_id,revision,line,model));")?;Ok(())}
pub fn prepare(case:&Case,query:&str,scope:Vec<String>)->Result<SearchJob> {
    ensure!(!query.trim().is_empty()&&query.len()<=4000,"Enter a bounded search query");schema(case)?;
    let mut passages=vec![];let mut pending=0;
    for source in &scope {
        ensure!(!case.source(source)?.restricted,"Restricted search source");
        let mut statement=case.db.prepare("SELECT revision,text FROM extracts WHERE source_id=?")?;
        let rows=statement.query_map([source],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for (revision,text) in rows {for (index,line) in text.lines().enumerate() {if line.trim().is_empty(){continue;}let clipped:String=line.chars().take(1200).collect();let hash=digest(clipped.as_bytes());
            let exists:bool=case.db.query_row("SELECT EXISTS(SELECT 1 FROM semantic_passages WHERE source_id=? AND revision=? AND line=? AND model=? AND text_hash=?)",params![source,revision,index+1,MODEL,hash],|r|r.get(0))?;
            if !exists {pending+=1;if passages.len()<256 {passages.push(Passage{source:source.clone(),revision,line:(index+1)as u64,text:clipped,hash});}}
        }}
    }
    let staging=tempfile::tempdir_in(case.root.join("staging"))?;
    let texts=std::iter::once(query.to_string()).chain(passages.iter().map(|p|p.text.clone())).collect::<Vec<_>>();
    std::fs::write(staging.path().join("request.json"),json!({"version":1,"kind":"embeddings","texts":texts}).to_string())?;
    Ok(SearchJob{staging,query:query.into(),scope,passages,pending})
}
pub fn run(job:&SearchJob)->Result<Value> {
    #[cfg(windows)]
    crate::sandbox::run_worker(&crate::processing::worker_path()?,job.staging.path(),std::time::Duration::from_secs(120))?;
    #[cfg(not(windows))]
    anyhow::bail!("Windows sandbox required");
    let path=job.staging.path().join("result.json");ensure!(path.metadata()?.len()<=8*1024*1024,"Embedding output too large");
    let result:Value=serde_json::from_slice(&std::fs::read(path)?)?;ensure!(result["status"]=="complete"&&result["model"]==MODEL,"{}",result["error"].as_str().unwrap_or("Embedding worker failed"));Ok(result)
}
fn vector(value:&Value)->Result<Vec<f64>> {let vector=value.as_array().context("Invalid vector")?;ensure!(vector.len()==384,"Invalid vector dimensions");vector.iter().map(|v|{let n=v.as_f64().context("Invalid vector number")?;ensure!(n.is_finite()&&n.abs()<=1.01,"Invalid normalized vector");Ok(n)}).collect()}
pub fn publish(case:&mut Case,job:&SearchJob,result:Value)->Result<Value> {
    schema(case)?;for source in &job.scope {ensure!(!case.source(source)?.restricted,"Source permission changed during search");}
    let vectors=result["vectors"].as_array().context("Missing vectors")?;ensure!(vectors.len()==job.passages.len()+1,"Embedding count mismatch");let query=vector(&vectors[0])?;
    case.db.execute_batch("SAVEPOINT semantic_publish")?;
    let published=(||->Result<()> {for (index,p) in job.passages.iter().enumerate() {
        vector(&vectors[index+1])?;
        let revision:i64=case.db.query_row("SELECT revision FROM extracts WHERE source_id=?",[&p.source],|r|r.get(0))?;ensure!(revision==p.revision,"Extraction changed during indexing");
        case.db.execute("INSERT INTO semantic_passages VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,revision,line,model) DO UPDATE SET text_hash=excluded.text_hash,text=excluded.text,vector=excluded.vector,truncated=excluded.truncated",params![p.source,p.revision,p.line,p.hash,p.text,vectors[index+1].to_string(),MODEL,result["truncated"][index+1].as_bool().unwrap_or(true)])?;
    }Ok(())})();
    if let Err(e)=published {case.db.execute_batch("ROLLBACK TO semantic_publish; RELEASE semantic_publish")?;return Err(e);}case.db.execute_batch("RELEASE semantic_publish")?;
    let terms=job.query.to_lowercase().split_whitespace().map(str::to_owned).collect::<Vec<_>>();
    let mut rows=vec![];
    for source in &job.scope {
        let mut statement=case.db.prepare("SELECT p.line,p.text,p.vector,p.truncated,p.revision FROM semantic_passages p JOIN extracts e ON e.source_id=p.source_id AND e.revision=p.revision WHERE p.source_id=? AND p.model=?")?;
        for row in statement.query_map(params![source,MODEL],|r|Ok((r.get::<_,u64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?,r.get::<_,i64>(4)?)))? {
            let (line,text,raw,truncated,revision)=row?;let values=vector(&serde_json::from_str(&raw)?)?;let score=query.iter().zip(values).map(|(a,b)|a*b).sum::<f64>();let lower=text.to_lowercase();let lexical=terms.iter().filter(|term|lower.contains(term.as_str())).count();
            rows.push((score,lexical,json!({"source_id":source,"name":case.source(source)?.name,"revision":revision,"locator":format!("evidence:{source}#R{revision}L{line}-L{line}"),"excerpt":text,"embedding_truncated":truncated,"semantic_similarity":score})));
        }
    }
    let mut semantic=(0..rows.len()).collect::<Vec<_>>();semantic.sort_by(|a,b|rows[*b].0.total_cmp(&rows[*a].0));let mut lexical=semantic.clone();lexical.sort_by_key(|i|std::cmp::Reverse(rows[*i].1));
    let mut scores=vec![0.;rows.len()];for (rank,index) in semantic.iter().enumerate(){scores[*index]+=1./(60.+rank as f64+1.);}for(rank,index)in lexical.iter().enumerate(){if rows[*index].1>0{scores[*index]+=1./(60.+rank as f64+1.);}}
    semantic.sort_by(|a,b|scores[*b].total_cmp(&scores[*a]));
    Ok(json!({"results":semantic.iter().take(30).map(|i|rows[*i].2.clone()).collect::<Vec<_>>(),"indexed_passages":rows.len(),"remaining_passages":job.pending.saturating_sub(job.passages.len()),"model":MODEL,"limitations":"English semantic similarity plus lexical rank fusion; not factual support. At most 256 new line passages indexed per call. Long lines use the first 1200 characters and may exceed the 256-token model window. Repeat to index remaining passages. No image or audio content search is implied."}))
}
