import { useEffect, useRef, useState } from 'react';
import { Sparkles, ArrowUp, Square, Play, ChevronDown, LoaderCircle, Settings2 } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { api, citationParts, native } from '../bridge';
import { configuredProfiles, profileKey, providerNames } from '../aiProfiles';
import type { Snapshot, Selection, Action } from '../types';


function CitedText({ text, onSource }: { text: string; onSource: (id: string, locator?: string) => void }) {
  return <div className="answer-text">{text.split(/(evidence:[a-zA-Z0-9-]+#(?:L\d+-L\d+|image|artifact:[a-zA-Z0-9-]+))/g).map((part, i) => {
    const citation = citationParts(part);
    return citation ? <button key={i} className="citation" title={part} onClick={() => onSource(citation.sourceId, citation.locator)}>{citation.locator === 'image' ? 'Image' : citation.locator.startsWith('artifact:') ? 'View source' : citation.locator}</button> : <span key={i}>{part.split(/(\*\*[^*]+\*\*)/g).map((segment,j)=>segment.startsWith('**')&&segment.endsWith('**')?<strong key={j}>{segment.slice(2,-2)}</strong>:segment)}</span>;
  })}</div>;
}
export default function AgentPanel({ snapshot, selection, refresh, run, onSource, onSettings, conversationId, onConversation }: { snapshot: Snapshot | null; selection: Selection; refresh: () => Promise<void>; run: (fn: () => Promise<void>) => void; onSource: (id: string, locator?: string) => void; onSettings: () => void; conversationId: string | null; onConversation: (id: string) => void }) {
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const availableModels = snapshot ? configuredProfiles(snapshot).filter(p => p.allow_text) : [];
  const selectedProfile = availableModels.find(p => profileKey(p) === selectedModel) ?? availableModels[0];
  useEffect(() => { setSelectedModel(sessionStorage.getItem(`vislex-model:${snapshot?.id}:${conversationId}`) ?? ''); }, [snapshot?.id, conversationId]);
  const [sending, setSending] = useState(false);
  const [live,setLive]=useState<{task:string;transmission:string;text:string;activity:string;characters:number}|null>(null);
  const [clock, setClock] = useState(Date.now());
  const [actions, setActions] = useState<Action[]>([]);
  const [team, setTeam] = useState<{id:string;role:string;phase:string;provider:string;model:string;status:string;step:number;answer:string;error:string}[]>([]);
  const [teamError, setTeamError] = useState('');
  const [showActions, setShowActions] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const turns = (snapshot?.tasks ?? []).filter(t => (t.conversation_id ?? t.id) === conversationId).slice().reverse();
  const task = turns.at(-1);
  const running = snapshot?.tasks.find(t => t.status === 'running');
  const automaticRunning = running?.id === snapshot?.automatic_analysis?.review_task && !!running;
  const chatBlocked = !!running && !automaticRunning;
  useEffect(()=>{if(!native)return;let active=true;const cleanup=listen<{case_id:string;task_id:string;transmission_id:string;delta:{text?:string;activity?:string;characters?:number}}>('agent-progress',({payload:p})=>{if(!active||p.case_id!==snapshot?.id)return;setLive(old=>{const previous=old?.transmission===p.transmission_id?old:{task:p.task_id,transmission:p.transmission_id,text:'',activity:'Receiving response',characters:0};return {...previous,text:(previous.text+(p.delta.text??'')).slice(-64000),activity:p.delta.activity?.replaceAll('_',' ')??previous.activity,characters:previous.characters+(p.delta.characters??0)};});});return()=>{active=false;void cleanup.then(unlisten=>unlisten());};},[snapshot?.id]);
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[running?.id]);
  useEffect(() => { setActions([]); setShowActions(false); following.current = true; setPrompt(sessionStorage.getItem(`vislex-draft:${snapshot?.id}:${conversationId}`) ?? ''); }, [snapshot?.id, conversationId]);
  useEffect(() => {
    let active = true;
    if (task && showActions) api<Action[]>('actions', { task_id: task.id }).then(a => { if (active) setActions(a); }).catch(e => {if(active)setActions([{id:'activity-error',name:'Activity unavailable',input:'',output:String(e),status:'failed',created_at:new Date().toISOString()}]);});
    else setActions([]);
    return () => { active = false; };
  }, [task?.id, task?.step, task?.status, showActions]);
  useEffect(() => {
    let active = true; setTeamError('');
    if (task && native && showActions) api<typeof team>('team_status', { task_id: task.id }).then(v => { if (active) setTeam(v); }).catch(e => { if (active) setTeamError(String(e)); });
    else setTeam([]);
    return () => { active = false; };
  }, [task?.id, task?.step, showActions]);
  useEffect(() => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [task?.id, task?.answer, task?.status, actions.length]);
  function draft(value: string) {setPrompt(value); sessionStorage.setItem(`vislex-draft:${snapshot?.id}:${conversationId}`, value);}
  function submit() { if (sending || chatBlocked || !prompt.trim() || !native || !snapshot || snapshot.settings.offline || !snapshot.settings.allow_text || !selectedProfile) return; setSending(true); run(async () => {
    try {
      const result = await api<{ task_id: string; conversation_id: string }>('start_task', { prompt, provider: selectedProfile!.provider, model: selectedProfile!.model, parent_task_id: task?.id ?? null, viewer_context: selection ? { ...selection, locator: selection.type==='source' && snapshot?.sources.find(s=>s.id===selection.id)?.kind==='pdf' ? `page:${document.querySelector('.pdf-navigation')?.textContent?.match(/Page (\d+)/)?.[1] ?? 1}` : selection.locator, time_seconds: selection.type==='source' ? document.querySelector<HTMLMediaElement>('.main-panel video, .main-panel audio')?.currentTime ?? null : null } : null });
      draft(''); following.current = true; onConversation(result.conversation_id ?? result.task_id); await refresh();
    } finally {setSending(false);}
  }); }
  const latestAction=actions.at(-1)?.name.replaceAll('_',' ');
  return <section className="agent-panel">
    <div className="panel-heading"><span className="chat-heading" title={turns[0]?.title??turns[0]?.prompt}>{turns[0]?.title ?? turns[0]?.prompt.slice(0, 65) ?? 'New chat'}</span><div className="spacer"/><button className="icon-button" aria-label="Agent settings" title="Agent settings" onClick={onSettings}><Settings2 size={16}/></button></div>
    <div className="agent-scroll" ref={scroll} onScroll={() => {const e=scroll.current;if(e) following.current=e.scrollHeight-e.scrollTop-e.clientHeight<100;}}>
      <div className="conversation-content">
      {turns.length ? turns.map(turn => <article className="conversation-turn" key={turn.id}>
        <div className="user-message">{turn.prompt}</div>
        {turn.id === task?.id ? <>
          <button className={`task-state ${turn.status === 'running' ? 'working' : ''}`} aria-expanded={showActions} onClick={() => setShowActions(v => !v)}>{turn.status === 'running' ? <LoaderCircle size={14} className="spin"/> : <span>{turn.status==='complete'?'✓':'⚠'}</span>}<span>{turn.status === 'running' ? latestAction ?? 'Considering the evidence…' : turn.status === 'complete' ? 'Activity' : turn.status}</span><ChevronDown size={13}/></button>
          {showActions && teamError ? <p role="alert">Team status unavailable: {teamError}</p> : null}
          {showActions && team.length ? <details className="team-panel"><summary>Agent team · {team.filter(a => a.status === 'complete').length}/{team.length} assignments complete</summary><p className="small muted">Separate working contexts. These proposals are not independent corroboration or human approval.</p>{team.map(a => <details key={a.id}><summary>{a.role} · {a.status} · {a.model}</summary><p className="small muted">{a.provider.replaceAll('"', '')} · {a.phase} · step {a.step}</p>{a.error ? <p role="alert">{a.error}</p> : null}{a.answer ? <CitedText text={a.answer} onSource={onSource}/> : <p>No completed proposal yet.</p>}</details>)}</details> : null}
          {showActions ? <div className="activity">{actions.map(a => <details key={a.id}><summary><span>{a.status==='failed'?'⚠':'✓'}</span><span>{a.name.replaceAll('_', ' ')} · {a.status}</span></summary><pre>{a.output}</pre><small>Receipt: {a.id}</small></details>)}</div> : null}
        </> : null}
        {showActions && turn.status==='running'?<div className="run-status" role="status">{Math.max(0,Math.floor((clock-Date.parse(turn.created_at))/1000))}s elapsed · step {turn.step} · {(turn.input_tokens+turn.output_tokens).toLocaleString()} tokens reported · {actions.filter(a=>a.status==='failed').length} failed actions{clock-Date.parse(turn.created_at)>60000?' · Still working. You can stop this run below.':''}</div>:null}
        {showActions && turn.status==='running'&&live?.task===turn.id?<div className="live-draft"><p className="run-status">{live.activity} · {live.characters} tool characters received</p>{live.text?<><small>Live draft — not yet citation-validated</small><pre>{live.text}</pre></>:null}</div>:null}
        {turn.answer ? <CitedText text={turn.answer} onSource={onSource}/> : null}
        {turn.error ? <div className="notice error" role="alert">{turn.error}<br/><small>Receipt: {turn.id}</small></div> : null}
        {turn.status === 'paused' && !running ? <button className="quiet" onClick={() => run(async () => {await api('resume_task', {task_id:turn.id});await refresh();})}><Play size={12}/>Resume work</button> : null}
      </article>) : <div className="agent-welcome"><div className="vislex-glyph"><Sparkles size={26}/></div><h1>What would you like<br/>to uncover?</h1><p>{snapshot ? `Investigate ${snapshot.name}, compare sources, or build your case.` : 'Open a case to bring your evidence and conversations together.'}</p><div className="starter-prompts">{['Build a timeline from the evidence', 'Find contradictions across sources', 'Review the videos and summarize key moments'].map(p => <button key={p} onClick={() => draft(p)}>{p}<ArrowUp size={14}/></button>)}</div></div>}
      </div>
    </div>
    <div className="composer-area">
      {snapshot && (snapshot.settings.offline || !snapshot.settings.allow_text || !availableModels.length) ? <button className="offline-notice" onClick={onSettings}>Set up or enable AI in settings</button> : null}
      <div className="composer">{selection?<div className="viewer-context" title="The agent receives this open file and its current playback position"><span>Viewing</span>{selection.type==='source'?snapshot?.sources.find(s=>s.id===selection.id)?.name:snapshot?.records.find(r=>r.id===selection.id)?.title}</div>:null}<textarea aria-label="Agent task" placeholder={task ? 'Follow up, challenge a finding, or ask something else…' : 'Ask VisLex to investigate your case…'} value={prompt} onChange={e => draft(e.target.value)} onKeyDown={e => {if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submit();}}}/>
      <div className="composer-bottom"><select className="chat-model-select" aria-label="Chat model" disabled={chatBlocked || sending || !availableModels.length} value={selectedProfile ? profileKey(selectedProfile) : ''} onChange={e => { setSelectedModel(e.target.value); sessionStorage.setItem(`vislex-model:${snapshot?.id}:${conversationId}`, e.target.value); }}>{!availableModels.length ? <option value="">Configure AI models</option> : Object.entries(providerNames).map(([provider, name]) => <optgroup label={name} key={provider}>{availableModels.filter(p => p.provider === provider).map(p => <option key={profileKey(p)} value={profileKey(p)}>{p.model}</option>)}</optgroup>)}</select><div className="spacer"/>{running && (!automaticRunning || !prompt.trim()) ? <button className="send stop" aria-label="Stop investigation" onClick={() => run(async () => {await api('stop_task',{task_id:running.id});await refresh();})}><Square size={15}/></button> : <button className="send" aria-label="Send message" disabled={sending||!prompt.trim()||!snapshot||!native||snapshot.settings.offline||!snapshot.settings.allow_text||!selectedProfile} onClick={submit}><ArrowUp size={19}/></button>}</div></div>
    </div>
  </section>;
}
