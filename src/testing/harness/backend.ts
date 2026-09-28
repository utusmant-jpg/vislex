// Synthetic in-memory backend for the mocked-IPC harness.
//
// Mirrors the request/response shapes of the Rust `command` dispatcher in
// src-tauri/src/desktop.rs closely enough to drive the real React code paths
// (case_id/session_epoch guards, case-event sequencing, paging cursors, agent
// streaming and cancellation). It is a test double: it does not establish that
// the packaged Tauri application behaves the same way.
import type { AIConfig, Settings, Source, Task, WorkingRecord } from '../../types';
import { buildHarborCase, buildRiversideCase, FIXTURE, syntheticId, type HarnessCase, type HarnessJob } from './fixtures';

export type HarnessCall = { cmd: string; action: string; args: Record<string, unknown>; at: number; outcome?: 'ok' | 'error'; error?: string; result?: unknown };
export type Emit = (event: string, payload: unknown) => void;
export type StreamOptions = { chunks?: string[]; intervalMs?: number; complete?: boolean };
export type Scenario = {
  /** Artificial latency per action (ms). */
  delays: Record<string, number>;
  /** Actions that reject with the given message; `times` limits how often. */
  failures: Record<string, { message: string; times?: number }>;
  /** Stream agent output automatically after start_task. */
  autoStream: boolean;
  stream: Required<StreamOptions>;
  /** Result for plugin:dialog|open (directory pick returns a case path by default). */
  dialogOpen: string | string[] | null | undefined;
  dialogSave: string | null;
  /** The native backend refuses to switch cases while processing jobs run. The
   *  fixture keeps display-only "running" jobs, so this guard is opt-in. */
  blockSwitchWhileJobsRun: boolean;
  /** Text deltas still delivered (within 150 ms) after stop_task for a task that
   *  was streaming, as desktop.rs's cancellation poll allows. */
  lateDeltasAfterStop: number;
};

// Read-only actions never emit case-event (mirrors the list in desktop.rs).
const READ_ONLY = new Set([
  'snapshot', 'ai_config', 'direct_media_permission', 'investigation_workbench', 'coverage_map', 'incident_replay', 'processing_recovery', 'team_status', 'read_dossier', 'read_coverage', 'evidence_list', 'evidence_read', 'evidence_search', 'fit_clock',
  'full_transcription_status', 'transcript_segment_page', 'transcript_segment_detail', 'artifact_info', 'read_text', 'extract_history', 'read_extract_revision', 'search',
  'actions', 'issue_history', 'record_detail', 'record_summary', 'source_detail', 'task_page', 'source_page', 'record_page', 'job_page', 'job_progress', 'attention_job_page', 'conversation_detail', 'case_summary',
  'revisions', 'processing_status', 'speaker_annotations', 'video_discovery_status', 'browse_video_discovery', 'storage_usage',
  // App-level reads handled (and returned early) before the case dispatcher in desktop.rs.
  'app_ai_settings', 'ai_access_route', 'codex_account_status', 'codex_account_models', 'codex_account_limits', 'provider_key_status', 'provider_models',
  // Not listed: case_ai_scope and case_ai_access_route are reads, but desktop.rs
  // dispatches them through the generic path and they are absent from its
  // read-only list, so the native backend emits case-event after them too.
]);

// Mutating actions whose desktop.rs branch returns early without calling
// emit_case_changed (hybrid_search and export_word publish via
// with_case_expected; key, access-route and Codex-selection branches return
// directly). codex_account_logout does emit, so it is not listed.
const NO_EMIT = new Set([
  'hybrid_search', 'export_word', 'verify_source',
  'save_provider_key', 'delete_provider_key', 'save_api_key', 'delete_api_key', 'key_status',
  'set_ai_access_route', 'save_codex_selection', 'codex_account_login', 'codex_account_cancel_login',
]);

const defaultStream = (source: string, email: string): string[] => {
  const text = `Synthetic streamed answer for harness testing. The statement places two people near the north entrance evidence:${source}#R2L5-L5 and the facilities email records two door openings evidence:${email}#L6-L6. Displayed clocks remain unverified, so this is not a finding.`;
  const words = text.split(/(?<= )/);
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += 3) chunks.push(words.slice(index, index + 3).join(''));
  return chunks;
};

export function defaultScenario(): Scenario {
  return { delays: {}, failures: {}, autoStream: true, stream: { chunks: defaultStream(FIXTURE.statement, FIXTURE.email), intervalMs: 90, complete: true }, dialogOpen: undefined, dialogSave: 'C:\\Synthetic\\exports\\harness-export.pdf', blockSwitchWhileJobsRun: false, lateDeltasAfterStop: 1 };
}

type Deferred = { action: string; release: () => void };
type StreamState = { timer: ReturnType<typeof setTimeout>; owner: HarnessCase; epoch: number; pendingText: string[] };

export class SyntheticBackend {
  cases: Map<string, HarnessCase> = new Map();
  active: HarnessCase | null = null;
  sessionEpoch = 0;
  eventSeq = 0;
  callLog: HarnessCall[] = [];
  scenario: Scenario = defaultScenario();
  appAi: { configured: boolean; config: AIConfig; settings: Settings } = { configured: true, config: { provider: 'openai', execution: 'auto', review: 'standard', pool: [{ provider: 'anthropic', model: 'harness-model-beta', allow_text: true, allow_images: false }] }, settings: { offline: false, allow_text: true, allow_images: false, model: 'harness-model-alpha' } };
  accessRoute: 'api_keys' | 'chatgpt_subscription' = 'api_keys';
  storedKeys = new Set<string>(['openai', 'anthropic']);
  private holds = new Set<string>();
  private waiting: Deferred[] = [];
  private streams = new Map<string, StreamState>();
  private liveText = new Map<string, string>();
  private speakerRevision = 0;

  /** Every event the backend emitted, for asserting delivery (or its absence). */
  emitted: { event: string; payload: unknown; at: number }[] = [];
  private emit: Emit;

  constructor(emit: Emit, options: { now?: number; startWith?: 'A' | 'none'; sourceCount?: number } = {}) {
    this.emit = (event, payload) => { this.emitted.push({ event, payload: safeClone(payload), at: Date.now() }); emit(event, payload); };
    const now = options.now ?? Date.now();
    const a = buildHarborCase(now, options.sourceCount);
    const b = buildRiversideCase(now);
    this.cases.set(a.root, a); this.cases.set(b.root, b);
    if (options.startWith !== 'none') { this.active = a; this.sessionEpoch = 1; }
  }

  /* ----------------------------- scenario controls ---------------------------- */
  setScenario(partial: Partial<Scenario>) { this.scenario = { ...this.scenario, ...partial, stream: { ...this.scenario.stream, ...(partial.stream ?? {}) } }; }
  delay(action: string, ms: number) { this.scenario.delays[action] = ms; }
  fail(action: string, message: string, times?: number) { this.scenario.failures[action] = { message, times }; }
  clearFailure(action: string) { delete this.scenario.failures[action]; }
  hold(action: string) { this.holds.add(action); }
  release(action: string) { this.holds.delete(action); const ready = this.waiting.filter(item => item.action === action); this.waiting = this.waiting.filter(item => item.action !== action); ready.forEach(item => item.release()); return ready.length; }
  pending(action?: string) { return this.waiting.filter(item => !action || item.action === action).length; }
  calls(action?: string) { return this.callLog.filter(call => !action || call.action === action); }
  clearCalls() { this.callLog = []; }

  /* --------------------------------- transport -------------------------------- */
  async handle(cmd: string, payload: Record<string, unknown> | undefined): Promise<unknown> {
    const isCommand = cmd === 'command';
    const action = isCommand ? String(payload?.action ?? '') : cmd;
    const args = (isCommand ? payload?.args : payload) as Record<string, unknown> ?? {};
    const call: HarnessCall = { cmd, action, args: safeClone(args), at: Date.now() };
    this.callLog.push(call);
    const wait = this.scenario.delays[action];
    try {
      const failure = this.scenario.failures[action];
      if (failure) {
        if (failure.times !== undefined) { failure.times -= 1; if (failure.times <= 0) delete this.scenario.failures[action]; }
        if (wait) await sleep(wait);
        throw new Error(failure.message);
      }
      // Compute the response now (as the real dispatcher would), deliver it later.
      const result = isCommand ? this.dispatch(action, args) : this.plugin(cmd, args);
      if (isCommand && !READ_ONLY.has(action) && !NO_EMIT.has(action)) this.caseChanged();
      if (wait) await sleep(wait);
      if (this.holds.has(action)) await new Promise<void>(release => this.waiting.push({ action, release }));
      call.outcome = 'ok';
      call.result = result === undefined ? null : safeClone(result);
      return safeClone(call.result);
    } catch (error) {
      call.outcome = 'error'; call.error = error instanceof Error ? error.message : String(error);
      // Tauri rejects invoke() with the error string, not an Error object.
      throw call.error;
    }
  }

  private plugin(cmd: string, args: Record<string, unknown>): unknown {
    if (cmd === 'plugin:dialog|open') {
      if (this.scenario.dialogOpen !== undefined) return this.scenario.dialogOpen;
      const options = (args.options ?? {}) as { directory?: boolean; multiple?: boolean };
      if (options.directory) return [...this.cases.values()].find(item => item !== this.active)?.root ?? null;
      return options.multiple ? ['C:\\Synthetic\\incoming\\new statement (SYNTHETIC).txt'] : 'C:\\Synthetic\\incoming\\archive.tar.age';
    }
    if (cmd === 'plugin:dialog|save') return this.scenario.dialogSave;
    if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:webview|') || cmd.startsWith('plugin:app|')) return null;
    throw new Error(`The synthetic harness does not implement ${cmd}`);
  }

  /* ------------------------------ event emission ------------------------------ */
  caseChanged() {
    this.eventSeq += 1;
    const payload = { case_id: this.active?.id ?? null, session_epoch: this.sessionEpoch, event_seq: this.eventSeq };
    if (this.active) this.active.lastUpdate = new Date().toISOString();
    setTimeout(() => { this.emit('case-event', payload); this.emit('case-changed', null); }, 0);
  }

  /** Emit agent-progress text deltas for a running task at a controllable pace.
   *  Text deltas carry only `{ text }`, as providers.rs and the subscription
   *  path in desktop.rs send them; tool activity is scripted with toolCall(). */
  streamTask(taskId: string, options: StreamOptions = {}) {
    const owner = this.findTaskCase(taskId);
    if (!owner) throw new Error(`Unknown task ${taskId}`);
    const { chunks, intervalMs, complete } = { ...this.scenario.stream, ...options };
    const epoch = this.sessionEpoch;
    const transmission = this.transmissionFor(taskId);
    let index = 0;
    const tick = () => {
      const task = owner.tasks.find(item => item.id === taskId);
      if (!task || task.status !== 'running') { this.streams.delete(taskId); return; }
      if (index < chunks.length) {
        const text = chunks[index++];
        this.liveText.set(taskId, (this.liveText.get(taskId) ?? '') + text);
        task.step = Math.max(task.step, Math.ceil(index / 4));
        task.output_tokens += Math.ceil(text.length / 4);
        this.emit('agent-progress', { case_id: owner.id, session_epoch: epoch, task_id: taskId, transmission_id: transmission, delta: { text } });
        this.streams.set(taskId, { timer: setTimeout(tick, intervalMs), owner, epoch, pendingText: chunks.slice(index) });
        return;
      }
      this.streams.delete(taskId);
      if (complete) this.completeTask(taskId);
    };
    this.streams.set(taskId, { timer: setTimeout(tick, intervalMs), owner, epoch, pendingText: chunks.slice() });
  }

  /** Script a provider function call the way the OpenAI Responses stream reports
   *  it: one `{ activity: <tool name> }` delta, then `{ characters }` deltas for
   *  the argument chunks. Tool names should be real agent tools (agent.rs). */
  toolCall(taskId: string, options: { name?: string; argumentChunks?: string[]; intervalMs?: number } = {}) {
    const owner = this.findTaskCase(taskId);
    if (!owner) throw new Error(`Unknown task ${taskId}`);
    const { name = 'search_passages', argumentChunks = ['{"terms":["north', ' entrance"],', '"offset":0}'], intervalMs = 60 } = options;
    const epoch = this.sessionEpoch;
    const transmission = this.transmissionFor(taskId);
    const deltas: Record<string, unknown>[] = [{ activity: name }, ...argumentChunks.map(chunk => ({ characters: new TextEncoder().encode(chunk).length }))];
    deltas.forEach((delta, index) => setTimeout(() => {
      if (owner.tasks.find(item => item.id === taskId)?.status !== 'running') return;
      this.emit('agent-progress', { case_id: owner.id, session_epoch: epoch, task_id: taskId, transmission_id: transmission, delta });
    }, intervalMs * (index + 1)));
  }

  private transmissionFor(taskId: string) { return syntheticId('transmission', hashTask(taskId)); }

  /** desktop.rs detects a stop by polling task status every 150 ms while the
   *  provider stream keeps emitting, so deltas can still arrive after Stop. */
  private emitLateDeltas(taskId: string, stream: StreamState) {
    const count = this.scenario.lateDeltasAfterStop;
    const chunks = stream.pendingText.length ? stream.pendingText : ['late ', 'delta '];
    for (let index = 0; index < count; index += 1) {
      const text = chunks[index % chunks.length];
      setTimeout(() => this.emit('agent-progress', { case_id: stream.owner.id, session_epoch: stream.epoch, task_id: taskId, transmission_id: this.transmissionFor(taskId), delta: { text } }), Math.round((150 / (count + 1)) * (index + 1)));
    }
  }

  completeTask(taskId: string, answer?: string) {
    const owner = this.findTaskCase(taskId);
    const task = owner?.tasks.find(item => item.id === taskId);
    if (!owner || !task) throw new Error(`Unknown task ${taskId}`);
    const stream = this.streams.get(taskId); if (stream) clearTimeout(stream.timer); this.streams.delete(taskId);
    task.status = 'complete'; task.answer = answer ?? this.liveText.get(taskId) ?? this.scenario.stream.chunks.join(''); task.input_tokens += 9_000;
    task.progress = { summary: 'Synthetic run complete', citations: [], gaps: ['Synthetic harness answer; no evidence was read'], next_steps: ['Open the cited statement lines', 'Check the door alarm clock'], checkpoint_step: task.step, duplicate_reads: 0 };
    (owner.actions[taskId] ??= []).push({ id: syntheticId('action', hashTask(taskId) + 7), name: 'finish_task', input: '{}', output: 'Synthetic completion receipt.', status: 'complete', created_at: new Date().toISOString() });
    this.liveText.delete(taskId);
    if (owner === this.active) this.caseChanged();
  }

  private findTaskCase(taskId: string) { return [...this.cases.values()].find(item => item.tasks.some(task => task.id === taskId)) ?? null; }

  /* ------------------------------- guard helpers ------------------------------ */
  private current(): HarnessCase { if (!this.active) throw new Error('Open a case first'); return this.active; }
  private checkEpoch(args: Record<string, unknown>) {
    if (args.session_epoch !== undefined && args.session_epoch !== null && args.session_epoch !== this.sessionEpoch) throw new Error('Case session changed; refresh before continuing');
  }
  /** require_session_epoch in desktop.rs. */
  private requireEpoch(args: Record<string, unknown>) {
    if (typeof args.session_epoch !== 'number') throw new Error('Missing session_epoch');
    if (args.session_epoch !== this.sessionEpoch) throw new Error('Case session changed; refresh before continuing');
  }
  /** provider_key_case_fence + require_session_epoch in desktop.rs: with a case
   *  open the request must name it and carry its epoch; with no case open, only
   *  an app-level request without a case_id is accepted. */
  private providerKeyFence(args: Record<string, unknown>) {
    const requested = args.case_id ?? null;
    const open = this.active?.id ?? null;
    if (!((open !== null && requested === open) || (open === null && requested === null))) throw new Error('Case changed before provider key update');
    if (open !== null) this.requireEpoch(args);
  }
  private requireCase(args: Record<string, unknown>, label: string, requireEpoch = false) {
    const c = this.current();
    if (args.case_id !== c.id) throw new Error(`Case changed before ${label}`);
    if (requireEpoch && typeof args.session_epoch !== 'number') throw new Error('Missing session_epoch');
    this.checkEpoch(args);
    return c;
  }
  private stamp<T extends object>(value: T) { return { ...value, session_epoch: this.sessionEpoch, event_seq: this.eventSeq }; }
  private source(c: HarnessCase, id: unknown) { const found = c.sources.find(item => item.id === id); if (!found) throw new Error('Source not found'); return found; }
  private publicSource(source: HarnessCase['sources'][number]): Source { const { revisions: _r, currentRevision: _c, pageCount: _p, durationSeconds: _d, ...rest } = source; return rest; }
  private summaryOf(record: WorkingRecord) { const { content: _content, ...rest } = record; return rest; }
  private touch(c: HarnessCase) { c.auditSeq += 1; }

  /* --------------------------------- paging ----------------------------------- */
  private sortedSources(c: HarnessCase) { return [...c.sources].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)); }
  private sourcePage(c: HarnessCase, before: { created_at: string; id: string } | null) {
    const all = this.sortedSources(c).filter(item => !before || item.created_at < before.created_at || (item.created_at === before.created_at && item.id < before.id));
    const page = all.slice(0, 50).map(item => this.publicSource(item));
    return { sources: page, next_cursor: all.length > 50 ? { created_at: page.at(-1)!.created_at, id: page.at(-1)!.id } : null };
  }
  private recordPage(c: HarnessCase, before: { updated_at: string; id: string } | null) {
    const all = [...c.records].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id)).filter(item => !before || item.updated_at < before.updated_at || (item.updated_at === before.updated_at && item.id < before.id));
    const page = all.slice(0, 50).map(item => this.summaryOf(item));
    return { records: page, next_cursor: all.length > 50 ? { updated_at: page.at(-1)!.updated_at, id: page.at(-1)!.id } : null };
  }
  private visibleTasks(c: HarnessCase) { return [...c.tasks].filter(task => !c.hiddenConversations.has(task.conversation_id ?? task.id)).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)); }
  private taskPage(c: HarnessCase, before: { created_at: string; id: string } | null) {
    const all = this.visibleTasks(c).filter(task => !before || task.created_at < before.created_at || (task.created_at === before.created_at && task.id < before.id));
    const page = all.slice(0, 50).map(task => ({ id: task.id, prompt: task.prompt.slice(0, 500), mode: task.mode, status: task.status, step: task.step, answer: task.answer.slice(0, 200), error: task.error.slice(0, 300), generation: task.generation, created_at: task.created_at, input_tokens: task.input_tokens, output_tokens: task.output_tokens, conversation_id: task.conversation_id ?? task.id, answer_truncated: task.answer.length > 200, title: c.titles[task.conversation_id ?? task.id] ?? null }));
    return { tasks: page, next_cursor: all.length > 50 ? { created_at: page.at(-1)!.created_at, id: page.at(-1)!.id } : null };
  }
  private jobPage(c: HarnessCase, before: number | null, attention = false) {
    const all = [...c.jobs].sort((a, b) => b.cursor - a.cursor).filter(job => (before === null || job.cursor < before) && (!attention || (['failed', 'interrupted'].includes(job.status) && !job.superseded)));
    const page = all.slice(0, 50);
    return { jobs: page.map(({ cursor: _c, priority: _p, attempt: _a, progress: _g, result: _r, ...job }) => job), next_cursor: all.length > 50 ? page.at(-1)!.cursor : null };
  }
  summary(c: HarnessCase) {
    const count = (status: string[]) => c.jobs.filter(job => status.includes(job.status)).length;
    return {
      case_id: c.id, generation: c.generation, audit_seq: c.auditSeq, action_rowid: Object.values(c.actions).flat().length, transmission_rowid: 0, viewer_request_hash: null, task_update: c.lastUpdate,
      tasks_running: c.tasks.filter(task => task.status === 'running').length, tasks_paused: c.tasks.filter(task => task.status === 'paused').length, tasks_complete: c.tasks.filter(task => task.status === 'complete').length,
      source_count: c.sources.length, source_bytes: c.sources.reduce((sum, item) => sum + item.size, 0), record_count: c.records.length, task_count: c.tasks.length, job_count: c.jobs.length,
      jobs_queued: count(['queued']), jobs_running: count(['running']), jobs_failed: count(['failed', 'interrupted']), jobs_attention: c.jobs.filter(job => ['failed', 'interrupted'].includes(job.status) && !job.superseded).length, jobs_complete: count(['complete']),
      chat_pause: c.chatPause,
    };
  }
  snapshot(c: HarnessCase) {
    const sources = this.sourcePage(c, null), records = this.recordPage(c, null), jobs = this.jobPage(c, null), attention = this.jobPage(c, null, true);
    const prepared = c.jobs.filter(job => job.kind === 'auto_prepare');
    return this.stamp({
      automatic_analysis: { files: prepared.length, prepared: prepared.filter(job => job.status === 'complete').length, pending: prepared.filter(job => ['queued', 'running'].includes(job.status)).length, failed: prepared.filter(job => ['failed', 'interrupted'].includes(job.status)).length, review_task: null, review_state: 'idle', note: 'Synthetic harness analysis status.' },
      ai_config: c.ai_config, jobs: jobs.jobs, job_next_cursor: jobs.next_cursor, attention_jobs: attention.jobs, attention_next_cursor: attention.next_cursor, issues: c.issues,
      id: c.id, name: c.name, root: c.root, generation: c.generation, sources: sources.sources, source_next_cursor: sources.next_cursor, records: records.records, record_next_cursor: records.next_cursor,
      counts: this.summary(c), settings: c.settings, tasks: this.taskPage(c, null).tasks, viewer_request: null,
    });
  }

  /* -------------------------------- text reads -------------------------------- */
  /** read_text (revision === null) reads the active extract; read_extract_revision
   *  reads an immutable revision. Like case.rs read_text_revision, a revision
   *  read is `historical` only when another revision is now active. */
  private readLines(c: HarnessCase, sourceId: unknown, revision: number | null, start: number, count: number) {
    const source = this.source(c, sourceId);
    if (revision === null && !source.revisions) throw new Error('No text extraction exists. Source is preserved; processing is pending.');
    const rev = revision ?? source.currentRevision;
    const lines = source.revisions?.[rev];
    if (!lines) throw new Error('Unknown extraction revision');
    if (!(start >= 1 && count > 0 && count <= 200)) throw new Error('Request 1–200 lines starting at line 1 or later');
    if (start > Math.max(lines.length, 1)) throw new Error(revision === null ? 'Line outside source' : 'Line outside revision');
    const end = Math.min(start - 1 + count, lines.length);
    return { source_id: source.id, revision: rev, start, end, total_lines: lines.length, text: lines.slice(start - 1, end).join('\n'), ...(revision !== null ? { historical: rev !== source.currentRevision, active_revision: source.currentRevision } : {}), truncated_long_lines: false, locator: `evidence:${source.id}#R${rev}L${start}-L${end}` };
  }

  /* -------------------------------- dispatcher -------------------------------- */
  dispatch(action: string, args: Record<string, unknown>): unknown {
    switch (action) {
      // ---- app-level AI configuration (no case required) ----
      case 'app_ai_settings': return safeClone(this.appAi);
      case 'save_app_ai_settings': {
        const config = args.config as AIConfig; const settings = { ...(args.settings as Settings) };
        if (this.appAi.configured && this.appAi.config.provider !== config.provider && args.grants_for_provider !== config.provider) { settings.allow_text = false; settings.allow_images = false; }
        this.appAi = { configured: true, config, settings };
        let updated = true;
        for (const c of this.cases.values()) if (c.aiScope === 'app') {
          if (c.tasks.some(task => task.status === 'running')) { if (c === this.active) updated = false; continue; }
          c.settings = { ...settings }; c.ai_config = safeClone(config);
        }
        return { saved: true, current_case_updated: updated };
      }
      case 'ai_access_route': return { route: this.accessRoute, subscription: null, subscription_ready: false, account_ready: false, blocker: 'The synthetic harness has no Codex runtime' };
      case 'set_ai_access_route': { const route = args.route as 'api_keys' | 'chatgpt_subscription'; if (route === 'chatgpt_subscription') throw new Error('Verified Codex sidecar is unavailable'); this.accessRoute = route; return { route }; }
      case 'codex_account_status': return { connected: false };
      case 'codex_account_login': case 'codex_account_models': case 'codex_account_limits': case 'save_codex_selection': throw new Error('Verified Codex sidecar is unavailable');
      case 'codex_account_cancel_login': case 'codex_account_logout': return null;
      case 'provider_key_status': return { configured: this.storedKeys.has(String(args.provider)) };
      case 'save_provider_key': case 'delete_provider_key': {
        this.providerKeyFence(args);
        if (action === 'delete_provider_key') { this.storedKeys.delete(String(args.provider)); return { deleted: true }; }
        if (typeof args.key !== 'string') throw new Error('Missing key');
        if (!args.key.trim()) throw new Error('Enter a key');
        this.storedKeys.add(String(args.provider)); return { saved: true };
      }
      case 'provider_models': {
        if (!this.storedKeys.has(String(args.provider))) throw new Error('Save an API key first');
        const provider = String(args.provider);
        return [{ id: `harness-model-${provider}-large`, name: `Harness ${provider} large (synthetic)` }, { id: `harness-model-${provider}-small`, name: `Harness ${provider} small (synthetic)` }, { id: provider === 'openai' ? 'harness-model-alpha' : provider === 'anthropic' ? 'harness-model-beta' : `harness-model-${provider}-mini`, name: 'Harness default (synthetic)' }];
      }
      case 'key_status': return { configured: this.storedKeys.size > 0 };
    }

    // ---- case lifecycle ----
    if (['create_case', 'open_case', 'restore_case', 'close_case'].includes(action)) {
      if (this.active) {
        // desktop.rs: with a case open, case_id (text(&args,"case_id")) and
        // session_epoch (require_session_epoch) are both mandatory.
        if (typeof args.case_id !== 'string') throw new Error('Missing case_id');
        if (args.case_id !== this.active.id) throw new Error('Case changed before switching');
        this.requireEpoch(args);
        if (this.active.tasks.some(task => task.status === 'running') || (this.scenario.blockSwitchWhileJobsRun && this.active.jobs.some(job => job.status === 'running'))) throw new Error('Stop active tasks and processing jobs before switching cases');
      }
      if (action === 'close_case') { this.active = null; this.sessionEpoch += 1; return null; }
      const path = String(args.path ?? '');
      let target = this.cases.get(path);
      if (!target && action !== 'open_case') {
        const base = buildRiversideCase(Date.now());
        target = { ...base, id: syntheticId('created-case', this.cases.size), name: String(args.name ?? 'Restored synthetic case'), root: path, sources: [], jobs: [], auditSeq: 1 };
        this.cases.set(path, target);
      }
      if (!target) throw new Error('This folder is not a VisLex case (synthetic harness knows only its fixture cases)');
      this.active = target; this.sessionEpoch += 1;
      return this.snapshot(target);
    }
    if (action === 'snapshot' && !this.active) return null;
    if (action === 'delete_case') { const c = this.requireCase(args, 'case deletion', true); if (String(args.confirm ?? '').trim().toLowerCase() !== c.name.toLowerCase()) throw new Error('Confirmation does not match the case name'); this.cases.delete(c.root); this.active = null; this.sessionEpoch += 1; return { deleted: true, bytes: 123_456_789 }; }

    const c = this.current();
    this.checkEpoch(args);
    switch (action) {
      case 'snapshot': return this.snapshot(c);
      case 'case_summary': if (args.case_id !== c.id) throw new Error('Case changed before summary'); return this.stamp(this.summary(c));
      case 'storage_usage': return { originals: c.sources.reduce((sum, item) => sum + item.size, 0), artifacts: 812_000_000, staging: 12_400_000, jobs: 4_100_000, database: 38_000_000, backups: 0, other: 1_024 };
      case 'reclaim_staging': this.requireCase(args, 'staging cleanup', true); return { reclaimed_bytes: 12_400_000 };
      case 'source_page': {
        this.requireCase(args, 'source page');
        if (args.generation !== c.generation || args.audit_seq !== c.auditSeq) throw new Error('Case changed before source page');
        return this.sourcePage(c, args.before as { created_at: string; id: string } | null);
      }
      case 'record_page': {
        this.requireCase(args, 'working file page');
        if (args.generation !== c.generation || args.audit_seq !== c.auditSeq) throw new Error('Case changed before working file page');
        return this.recordPage(c, args.before as { updated_at: string; id: string } | null);
      }
      case 'task_page': this.requireCase(args, 'task page'); return this.taskPage(c, (args.before ?? null) as { created_at: string; id: string } | null);
      case 'job_page': this.requireCase(args, 'job page'); return this.jobPage(c, typeof args.before === 'number' ? args.before : null);
      case 'attention_job_page': this.requireCase(args, 'current problems page'); return this.jobPage(c, typeof args.before === 'number' ? args.before : null, true);
      case 'job_progress': {
        this.requireCase(args, 'job progress');
        const job = c.jobs.find(item => item.id === args.job_id); if (!job) throw new Error('Job not found');
        return { job_id: job.id, kind: job.kind, status: job.status, priority: job.priority, attempt: job.attempt, heartbeat: new Date().toISOString(), progress: job.progress };
      }
      case 'source_detail': this.requireCase(args, 'source detail'); return this.publicSource(this.source(c, args.source_id));
      case 'record_summary': { this.requireCase(args, 'working file summary'); const record = c.records.find(item => item.id === args.record_id); if (!record) throw new Error('Working file not found'); return this.summaryOf(record); }
      case 'record_detail': { this.requireCase(args, 'record detail'); const record = c.records.find(item => item.id === args.record_id); if (!record) throw new Error('Working file not found'); if (record.revision !== args.revision) throw new Error('Record revision changed; refresh before editing'); return record; }
      case 'conversation_detail': {
        this.requireCase(args, 'conversation detail');
        const id = String(args.conversation_id); if (c.hiddenConversations.has(id)) throw new Error('Conversation is hidden');
        const before = args.before as { created_at: string; id: string } | null | undefined;
        const all = c.tasks.filter(task => (task.conversation_id ?? task.id) === id).sort((a, b) => b.created_at.localeCompare(a.created_at)).filter(task => !before || task.created_at < before.created_at);
        const tasks = all.slice(0, 50).map(task => ({ ...task, conversation_id: id, title: c.titles[id] ?? null, progress: task.progress ?? { summary: '', citations: [], gaps: [], next_steps: [], checkpoint_step: 0, duplicate_reads: 0 } }));
        return { tasks, has_older: all.length > 50, next_cursor: all.length > 50 ? { created_at: tasks.at(-1)!.created_at, id: tasks.at(-1)!.id } : null };
      }
      case 'actions': return c.actions[String(args.task_id)] ?? [];
      case 'team_status': return [];
      case 'issue_history': return { receipts: [{ id: String(args.receipt_id), created_at: new Date().toISOString() }, { id: syntheticId('receipt', 1), created_at: new Date(Date.now() - 3_600_000).toISOString() }], next_offset: null };
      case 'read_text': return this.readLines(c, args.source_id, null, Number(args.start ?? 1), Number(args.count ?? 200));
      case 'read_extract_revision': return this.readLines(c, args.source_id, Number(args.revision), Number(args.start ?? 1), Number(args.count ?? 200));
      case 'search': case 'hybrid_search': {
        if (action === 'hybrid_search') this.requireCase(args, 'search', true);
        const query = String(args.query ?? '').toLowerCase();
        const results = c.sources.filter(item => !item.restricted && item.revisions).flatMap(item => { const lines = item.revisions![item.currentRevision]; const index = lines.findIndex(line => line.toLowerCase().includes(query)); return index >= 0 ? [{ source_id: item.id, name: item.name, excerpt: lines[index], locator: `evidence:${item.id}#R${item.currentRevision}L${index + 1}-L${index + 1}` }] : []; }).slice(0, 20);
        return action === 'hybrid_search' ? { results, remaining_passages: 0 } : { results, next_offset: null };
      }
      case 'revisions': return c.recordHistory[String(args.record_id)] ?? [];

      // ---- mutations on records and sources ----
      case 'rename': {
        this.requireCase(args, 'rename', true);
        const name = String(args.name);
        if (args.kind === 'case') c.name = name;
        else if (args.kind === 'source') { const item = this.source(c, args.id); item.name = name; }
        else if (args.kind === 'chat') c.titles[String(args.id)] = name;
        this.touch(c); return null;
      }
      case 'set_restricted': { this.requireCase(args, 'restriction change', true); this.source(c, args.source_id).restricted = Boolean(args.restricted); this.touch(c); return null; }
      case 'write_record': {
        this.requireCase(args, 'working file save', true);
        const old = c.records.find(item => item.id === args.record_id);
        if (old && old.revision !== args.base_revision) throw new Error('This record changed. Reload before saving.');
        if (old?.protected && args.actor === 'agent') throw new Error('Agent edits are locked');
        const record: WorkingRecord = { id: old?.id ?? syntheticId('record', 10_000 + c.records.length), title: String(args.title), kind: String(args.kind), content: String(args.content), revision: Number(args.base_revision) + 1, actor: 'human', review: 'unreviewed', protected: old?.protected ?? false, stale: false, updated_at: new Date().toISOString(), dependencies: (args.source_ids as string[]) ?? [] };
        c.records = [record, ...c.records.filter(item => item.id !== record.id)];
        (c.recordHistory[record.id] ??= []).push({ revision: record.revision, title: record.title, content: record.content, actor: 'human', review: 'unreviewed', reason: String(args.reason ?? 'Manual editor save'), task_id: null, created_at: record.updated_at });
        this.touch(c); return record;
      }
      case 'review_record': {
        this.requireCase(args, 'review', true);
        const record = c.records.find(item => item.id === args.record_id); if (!record) throw new Error('Working file not found');
        if (record.revision !== args.revision) throw new Error('Record revision changed; refresh before reviewing');
        if (typeof args.protected === 'boolean') record.protected = args.protected; else { if (record.stale) throw new Error('Recheck stale dependencies before review'); record.review = 'human-reviewed'; }
        this.touch(c); return null;
      }
      case 'rollback': {
        this.requireCase(args, 'rollback', true);
        const record = c.records.find(item => item.id === args.record_id); if (!record) throw new Error('Working file not found');
        if (record.revision !== args.base_revision) throw new Error('This record changed. Reload before restoring.');
        const target = c.recordHistory[record.id]?.find(item => item.revision === args.target); if (!target) throw new Error('Unknown revision');
        Object.assign(record, { content: target.content, title: target.title, revision: record.revision + 1, updated_at: new Date().toISOString(), review: 'unreviewed' });
        c.recordHistory[record.id].push({ ...target, revision: record.revision, reason: `Restore revision ${target.revision}`, created_at: record.updated_at });
        this.touch(c); return record;
      }
      case 'export_record': case 'export_word': { this.requireCase(args, 'export', true); const record = c.records.find(item => item.id === args.record_id); if (!record || record.revision !== args.expected_revision) throw new Error('Record revision changed before export'); return { path: args.path, revision: record.revision }; }
      case 'delete_conversation': {
        this.requireCase(args, 'chat deletion', true);
        const id = String(args.conversation_id);
        if (c.tasks.some(task => (task.conversation_id ?? task.id) === id && task.status === 'running')) throw new Error('Stop the running chat before deleting it');
        if (args.deleted === false) c.hiddenConversations.delete(id); else c.hiddenConversations.add(id);
        this.touch(c); return null;
      }

      // ---- AI settings for the case ----
      case 'save_ai_settings': {
        this.requireCase(args, 'AI settings update', true);
        c.settings = { ...(args.settings as Settings) }; c.ai_config = safeClone(args.config as AIConfig); c.aiScope = 'case'; this.touch(c); return null;
      }
      case 'case_ai_scope': return { scope: c.aiScope };
      case 'set_case_ai_scope': {
        this.requireCase(args, 'AI scope update', true);
        const scope = args.scope as 'app' | 'case';
        if (scope === 'app') { if (c.tasks.some(task => task.status === 'running')) throw new Error('Stop the current AI task before applying app settings'); c.settings = { ...this.appAi.settings }; c.ai_config = safeClone(this.appAi.config); }
        c.aiScope = scope; this.touch(c); return { scope };
      }
      case 'case_ai_access_route': this.requireCase(args, 'AI access read', true); return { override: c.accessOverride, effective: c.accessOverride === 'app' ? this.accessRoute : c.accessOverride, selection_override: false, selection: null };
      case 'set_case_ai_access_route': {
        this.requireCase(args, 'AI access update', true);
        const route = args.route as HarnessCase['accessOverride'];
        if (route === 'chatgpt_subscription') throw new Error('Verified Codex sidecar is unavailable');
        c.accessOverride = route; return { override: route, effective: route === 'app' ? this.accessRoute : route, selection_override: false, selection: null };
      }
      case 'save_case_codex_selection': throw new Error('Verified Codex sidecar is unavailable');
      case 'direct_media_permission': return { enabled: c.directMedia };
      case 'set_direct_media_permission': this.requireCase(args, 'media permission update', true); c.directMedia = Boolean(args.enabled); this.touch(c); return null;
      case 'ai_config': return c.ai_config;

      // ---- chat tasks ----
      case 'start_task': {
        this.requireCase(args, 'chat started', true);
        if (c.chatPause) throw new Error(c.chatPause);
        if (c.settings.offline) throw new Error('Offline mode enabled');
        if (!c.settings.allow_text) throw new Error('Case text may not be sent to AI; enable it in Settings');
        const provider = args.provider as string | undefined, model = args.model as string | undefined;
        const profiles = [{ provider: c.ai_config.provider, model: c.settings.model, allow_text: c.settings.allow_text }, ...c.ai_config.pool];
        const profile = provider && model ? profiles.find(item => item.provider === provider && item.model === model) : profiles[0];
        if (!profile || !profile.model) throw new Error('Select a permitted model in Settings');
        if (!profile.allow_text) throw new Error('This model is not permitted to receive case text');
        if (!this.storedKeys.has(profile.provider)) throw new Error('Save an API key in Settings first');
        const parent = c.tasks.find(task => task.id === args.parent_task_id);
        const id = syntheticId('live-task', c.tasks.length + this.callLog.length);
        const conversation = parent ? parent.conversation_id ?? parent.id : id;
        const task: Task = { id, conversation_id: conversation, prompt: String(args.prompt), mode: 'investigate', status: 'running', input_tokens: 0, output_tokens: 0, step: 0, answer: '', error: '', generation: c.generation, created_at: new Date().toISOString(), title: null };
        c.tasks.push(task);
        c.actions[id] = [{ id: syntheticId('action', hashTask(id)), name: 'search_passages', input: '{"terms":["synthetic"],"offset":0}', output: 'Synthetic search receipt from the harness.', status: 'complete', created_at: task.created_at }];
        if (this.scenario.autoStream) this.streamTask(id);
        return { task_id: id, conversation_id: conversation };
      }
      case 'stop_task': {
        this.requireCase(args, 'chat stopped', true);
        const task = c.tasks.find(item => item.id === args.task_id);
        if (task && task.status === 'running') { task.status = 'paused'; task.error = 'Stopped by user'; const stream = this.streams.get(task.id); if (stream) { clearTimeout(stream.timer); this.emitLateDeltas(task.id, stream); } this.streams.delete(task.id); this.liveText.delete(task.id); }
        return null;
      }
      case 'resume_task': {
        this.requireCase(args, 'chat resumed', true);
        const task = c.tasks.find(item => item.id === args.task_id); if (!task) throw new Error('Task not found');
        if (c.settings.offline || !c.settings.allow_text) throw new Error('API permission is disabled');
        task.status = 'running'; task.error = ''; if (this.scenario.autoStream) this.streamTask(task.id);
        return { task_id: task.id };
      }
      case 'continue_paused_task': {
        this.requireCase(args, 'chat continued', true);
        const old = c.tasks.find(item => item.id === args.task_id); if (!old) throw new Error('Task not found');
        const id = syntheticId('continued-task', c.tasks.length);
        const conversation = id;
        c.tasks.push({ ...old, id, conversation_id: conversation, status: 'running', answer: '', error: '', step: 0, input_tokens: 0, output_tokens: 0, created_at: new Date().toISOString() });
        if (this.scenario.autoStream) this.streamTask(id);
        return { task_id: id, conversation_id: conversation };
      }

      // ---- jobs ----
      case 'transcribe_all': this.requireCase(args, 'transcription queue', true); return { queued: 0 };
      case 'cancel_processing': { this.requireCase(args, 'processing cancellation', true); this.setJob(c, args.job_id, 'cancelled'); return null; }
      case 'resume_processing': { this.requireCase(args, 'processing recovery', true); this.setJob(c, args.job_id, 'queued'); return null; }
      case 'resume_transcription': { this.requireCase(args, 'transcription recovery', true); this.setJob(c, args.job_id, 'queued'); return null; }
      case 'retry_video_discovery': { this.requireCase(args, 'video discovery retry', true); this.setJob(c, args.run_id, 'queued'); return null; }
      case 'transcribe_full': case 'cancel_transcription': {
        this.requireCase(args, 'transcription', true);
        const job = c.jobs.find(item => item.source_id === args.source_id && item.kind === 'full_audio');
        if (job) { job.status = action === 'transcribe_full' ? 'queued' : 'cancelled'; job.error = ''; job.progress = null; }
        return null;
      }
      case 'set_asr_profile': this.requireCase(args, 'ASR profile', true); return null;
      case 'full_transcription_status': {
        const t = c.transcripts[String(args.source_id)]; if (!t) return null;
        const record = c.records.find(item => item.id === t.recordId) ?? null;
        return { job_id: t.jobId, status: t.status, error: '', progress: t.progress ?? {}, result: t.status === 'complete' ? { segmented: true, segments: t.segments.length, saved_files: [], metadata: { container_origin_seconds: 0, tracks: [{ index: 0, origin_seconds: 0 }] } } : {}, record };
      }
      case 'transcript_segment_page': {
        this.requireCase(args, 'transcript page');
        const t = c.transcripts[String(args.source_id)]; if (!t) throw new Error('No transcript run');
        const cursor = typeof args.cursor === 'number' ? args.cursor : 0;
        const segments = t.segments.slice(cursor, cursor + 25);
        return { segments, next_cursor: cursor + 25 < t.segments.length ? cursor + 25 : null };
      }
      case 'propose_transcript_correction': this.requireCase(args, 'transcript correction', true); return { id: syntheticId('correction', Number(args.ordinal)), revision: 1 };
      case 'review_transcript_correction': this.requireCase(args, 'correction review', true); return null;
      case 'processing_status': {
        if (args.source_id !== FIXTURE.call) return [];
        return [{ kind: 'diarization', status: 'complete', result: JSON.stringify({ metadata: { turns: Array.from({ length: 24 }, (_, index) => ({ start: index * 8, end: index * 8 + 7, speaker: `SPEAKER_0${index % 3 === 2 ? 2 : index % 2}` })), track_index: 0, origin_seconds: 0, container_origin_seconds: 0, gap_seconds: 0.4 }, extraction_locator: `evidence:${FIXTURE.call}#artifact:${syntheticId('artifact', 77)}`, limitations: ['Synthetic speaker clusters. Labels never establish identity.'] }) }];
      }
      case 'diarize_source': this.requireCase(args, 'speaker analysis'); return { metadata: { turns: [{ start: 0, end: 5, speaker: 'SPEAKER_00' }, { start: 5, end: 11, speaker: 'SPEAKER_01' }], track_index: Number(args.track ?? 0), origin_seconds: 0, container_origin_seconds: 0, gap_seconds: 0 }, extraction_locator: `evidence:${args.source_id}#artifact:${syntheticId('artifact', 78)}`, limitations: ['Synthetic diarization proposal.'] };
      case 'speaker_annotations': return { revision: this.speakerRevision, labels: {}, turns: {} };
      case 'save_speaker_annotations': this.requireCase(args, 'speaker annotations', true); this.speakerRevision += 1; return { revision: this.speakerRevision, labels: args.labels ?? {}, turns: args.turns ?? {} };

      // ---- viewer derivatives ----
      case 'probe_pdf': { this.requireCase(args, 'PDF probe'); const source = this.source(c, args.source_id); if (!source.pageCount) throw new Error('This synthetic PDF has no rendered pages'); return { metadata: { page_count: source.pageCount, first_page_size_points: [612, 792] } }; }
      case 'render_page': { this.requireCase(args, 'page render'); const source = this.source(c, args.source_id); const page = Number(args.page); if (!source.pageCount || page < 1 || page > source.pageCount) throw new Error('Requested page is outside this document'); return { published: [{ artifact_id: `page-${source.id}-${page}`, metadata: { page, page_count: source.pageCount, page_size_points: [612, 792] } }], limitations: ['Synthetic placeholder page image; no real document was rendered.'] }; }
      case 'process_source': { this.requireCase(args, 'processing'); const source = this.source(c, args.source_id); return { published: source.kind === 'image' ? [{ artifact_id: `image-${source.id}` }] : [], limitations: ['Synthetic harness processing receipt.'] }; }
      case 'playback_proxy': throw new Error('Playback derivatives are not available in the synthetic harness. Original media bytes are not included.');
      case 'step_video_frame': throw new Error('Exact frame decoding is not available in the synthetic harness.');
      case 'artifact_info': { const id = String(args.artifact_id); return { mime: id.startsWith('image-') || id.startsWith('frame-') || id.startsWith('page-') ? 'image/jpeg' : 'application/json', content: null, metadata: {} }; }
      case 'browse_video_discovery': {
        const source = this.source(c, args.source_id);
        const start = Number(args.start ?? 0), end = Math.min(Number(args.end ?? 3600), source.durationSeconds ?? 0);
        const samples = [] as { artifact_id: string; locator: string; metadata: { source_relative_seconds: number; playback_seconds: number; scene_boundary: boolean; ocr?: { text: string } } }[];
        for (let time = Math.ceil(start / 30) * 30; time <= end && samples.length < 30; time += 30) samples.push({ artifact_id: `frame-${source.id}-${time}`, locator: `evidence:${source.id}#artifact:${syntheticId('frame', time)}`, metadata: { source_relative_seconds: time, playback_seconds: time, scene_boundary: time % 150 === 0, ...(args.kind === 'video_ocr' ? { ocr: { text: `SYNTHETIC OVERLAY 14:${String(30 + Math.floor(time / 60)).padStart(2, '0')}` } } : {}) } });
        const job = c.jobs.find(item => item.source_id === source.id && ['video_overview_index', 'video_ocr_index'].includes(item.kind));
        return { samples, next_offset: null, status: { jobs: job ? [{ id: job.id, kind: job.kind, status: job.status, error: job.error, result: { next_start: job.progress?.completed ?? 0, interval: 5 } }] : [], note: 'Synthetic sampled frames.' } };
      }
      case 'queue_video_discovery': case 'cancel_video_discovery': this.requireCase(args, 'video discovery', true); return null;
      case 'scan_sound_events': this.requireCase(args, 'sound scan'); return { extraction_locator: `evidence:${args.source_id}#artifact:${syntheticId('artifact', 79)}`, limitations: ['Synthetic transient scan.'], metadata: { requested_interval: [Number(args.start), Number(args.end)], channel: Number(args.channel ?? 0), track_index: 0, decoded_seconds: Number(args.end) - Number(args.start), gap_seconds: 0, candidates: [{ source_relative_seconds: 3.25, label: 'unclassified transient', clipping_fraction: 0, onset_resolution_seconds: 0.01, alternatives: [] }], waveform: Array.from({ length: 40 }, (_, index) => ({ start_seconds: index, peak: (Math.sin(index) + 1) / 3, fully_decoded: index !== 17 })) } };

      // ---- redaction ----
      case 'prepare_redaction': { this.requireCase(args, 'redaction'); const source = this.source(c, args.source_id); const pages = source.kind === 'pdf' ? Math.min(source.pageCount ?? 1, 3) : 1; return { published: [...Array.from({ length: pages }, (_, index) => ({ artifact_id: `page-redacted-${source.id}-${index + 1}`, metadata: { mime: 'image/jpeg', page: index + 1, page_count: pages } })), { artifact_id: `redacted-${source.id}`, metadata: { mime: 'application/pdf', page_count: pages } }] }; }
      case 'review_redaction': this.requireCase(args, 'redaction review', true); return null;
      case 'export_redaction': this.requireCase(args, 'redaction export', true); return { path: args.path };

      // ---- findings / structured evidence ----
      case 'evidence_list': {
        this.requireCase(args, 'evidence list');
        const offset = Number(args.offset ?? 0); const all = c.evidence.filter(item => !args.kind || item.kind === args.kind);
        return { objects: all.slice(offset, offset + 50), next_offset: offset + 50 < all.length ? offset + 50 : null };
      }
      case 'evidence_read': { this.requireCase(args, 'evidence read'); const found = c.evidence.find(item => item.id === args.id); if (!found) throw new Error('Object not found'); return found; }
      case 'evidence_write': {
        this.requireCase(args, 'evidence write', true);
        const object = args.object as Record<string, unknown>;
        for (const locator of (object.locators as string[] | undefined) ?? []) if (!/^evidence:[a-zA-Z0-9-]+#/.test(locator)) throw new Error(`Citation must start with evidence: (${locator})`);
        const existing = c.evidence.find(item => item.id === object.id);
        if (existing && existing.revision !== object.base_revision) throw new Error('This object changed. Reload before saving.');
        const next = { id: existing?.id ?? syntheticId('object', 5000 + c.evidence.length), revision: (existing?.revision ?? 0) + 1, kind: String(object.kind ?? existing?.kind), title: String(object.title), content: String(object.content), source_ids: (object.source_ids as string[]) ?? [], locators: (object.locators as string[]) ?? [], review: 'unreviewed', stale: false, actor: 'human', start_seconds: null, end_seconds: null, dependencies: (object.dependencies as { id: string; revision: number }[]) ?? [] };
        c.evidence = [next, ...c.evidence.filter(item => item.id !== next.id)]; this.touch(c); return next;
      }
      case 'evidence_review': { this.requireCase(args, 'evidence review', true); const found = c.evidence.find(item => item.id === args.id); if (!found || found.revision !== args.revision) throw new Error('Object revision changed'); if (found.stale) throw new Error('Recheck dependencies first'); found.review = String(args.review); this.touch(c); return null; }
      case 'fit_clock': return { status: 'held_out_checks_passed', scale: 1.0000021, offset_seconds: 100.004, uncertainty_seconds: 0.041, drift_estimated: true, held_out_checks_passed: true, valid_source_range: [0, 60], residuals: ((args.anchors as { held_out: boolean }[]) ?? []).map((anchor, index) => ({ residual_seconds: 0.01 * (index + 1), held_out: anchor.held_out, within_tolerance: true })), limitations: ['Synthetic fit; anchors were not independently checked.'] };
      case 'investigation_workbench': this.requireCase(args, 'workbench'); return { investigations: c.investigations, affected_objects: c.evidence.filter(item => item.stale).map(item => ({ id: item.id, title: item.title, kind: item.kind, revision: item.revision })), next_offset: null };
      case 'coverage_map': {
        this.requireCase(args, 'coverage');
        const offset = Number(args.offset ?? 0);
        const rows = this.sortedSources(c).filter(item => !item.restricted).slice(offset, offset + 50).map(item => ({ source_id: item.id, name: item.name, status: item.status, extracted_lines: item.revisions?.[item.currentRevision]?.length ?? 0, rendered_pages: item.pageCount ? [1, 2] : [], sampled_frame_count: item.kind === 'video' ? 12 : 0, sampled_seconds: item.kind === 'video' ? [0, 30, 60] : [], inspection_receipts: item.id === FIXTURE.statement ? 4 : 0, failed_jobs: c.jobs.filter(job => job.source_id === item.id && ['failed', 'interrupted'].includes(job.status)).length, next_check: 'Inspect the original and record what was checked.' }));
        return { sources: rows, next_offset: offset + 50 < c.sources.length ? offset + 50 : null, note: 'Synthetic coverage map. Counts describe fixture data only.' };
      }
      case 'read_dossier': {
        this.requireCase(args, 'dossier');
        const item = c.investigations.find(entry => entry.task_id === args.task_id); if (!item) throw new Error('No dossier for this task');
        return { dossier: { revision: item.view.dossier.revision, scope: 'Synthetic scope: statement W-01, facilities email, camera 04 samples.', checks: [{ id: 'check-1', description: 'Read W-01 original wording', state: 'done', reason: '', receipts: ['r1', 'r2'] }, { id: 'check-2', description: 'Inspect camera 04 frames 14:30–14:36', state: 'open', reason: 'Frames between samples not decoded', receipts: [] }], claims: item.view.dossier.claims }, stale: item.view.stale, completion_stale: item.view.completion_stale, completion: { outcome: 'partial', gaps: ['Camera clock unreconciled'], created_at: new Date().toISOString() }, human_reviews: item.view.dossier.claims.map(() => null), coverage_note: 'Synthetic coverage note.' };
      }
      case 'review_dossier_claim': this.requireCase(args, 'dossier review', true); return this.dispatch('read_dossier', { case_id: args.case_id, task_id: args.task_id });
      case 'incident_replay': this.requireCase(args, 'incident replay'); throw new Error('Synchronized replay needs playback derivatives, which the synthetic harness does not provide.');
      case 'export_dossier_bundle': this.requireCase(args, 'dossier export', true); return { path: args.path };
      case 'fetch_public_authority': this.requireCase(args, 'authority retrieval', true); throw new Error('Network retrieval is disabled in the synthetic harness.');

      // ---- import / backup ----
      case 'import_files': case 'import_folder': {
        this.requireCase(args, 'import', true);
        const paths = action === 'import_files' ? (args.paths as string[]) : [String(args.path)];
        const items = paths.map((path, index) => { const name = path.split(/[\\/]/).pop() ?? `import-${index}`; const id = syntheticId('imported', c.sources.length + index); c.sources.push({ id, name, sha256: syntheticId('sha', index).replaceAll('-', '').padEnd(64, '0'), size: 1234, mime: 'text/plain', kind: 'text', status: 'text indexed', restricted: false, occurrences: 1, created_at: new Date().toISOString(), revisions: { 1: ['SYNTHETIC — NOT REAL EVIDENCE', 'Imported by the harness.'] }, currentRevision: 1 }); return { status: 'imported', detail: { source_id: id } }; });
        this.touch(c); return { items, skipped: [] };
      }
      case 'backup': this.requireCase(args, 'backup', true); return { path: args.path };
    }
    throw new Error('Unknown application command');
  }

  private setJob(c: HarnessCase, id: unknown, status: string) {
    const job = c.jobs.find(item => item.id === id); if (!job) throw new Error('Job not found');
    job.status = status; if (status !== 'running') job.progress = null; if (status === 'queued') job.error = '';
  }

  /* ---------------------------- scripting helpers ---------------------------- */
  setJobProgress(jobId: string, progress: HarnessJob['progress'], status?: string) {
    const c = this.current(); const job = c.jobs.find(item => item.id === jobId); if (!job) throw new Error('Job not found');
    job.progress = progress; if (status) job.status = status; this.caseChanged();
  }
  setChatPause(reason: string | null) { this.current().chatPause = reason; this.caseChanged(); }
  activeSummary() { return this.active ? { id: this.active.id, name: this.active.name, root: this.active.root, session_epoch: this.sessionEpoch, event_seq: this.eventSeq } : null; }
  task(taskId: string) { return this.findTaskCase(taskId)?.tasks.find(task => task.id === taskId) ?? null; }
}

function hashTask(id: string) { let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0; return hash % 100_000; }
function sleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }
export function safeClone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
