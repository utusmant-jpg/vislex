// Plain-language summaries of recorded agent actions. Every phrase is derived
// from the stored action row (tool name, arguments, result, status); nothing is
// inferred beyond those fields. Unknown tools fall back to their name.
import type { Action } from '../types';

export type StepKind = 'search' | 'read' | 'look' | 'watch' | 'listen' | 'save' | 'check' | 'team' | 'finish' | 'browse' | 'other';

export type StepFact = { label: string; value: string };
export type StepExcerpt = { text: string; locator?: string; title?: string };

export type StepSummary = {
  id: string;
  name: string;
  kind: StepKind;
  /** Leading verb phrase, e.g. "Searched for". */
  verb: string;
  /** The thing acted on, usually a source name, rendered with emphasis. */
  object?: string;
  sourceId?: string;
  sourceIds?: string[];
  /** Qualifier after the object, e.g. "lines 1–120". */
  detail?: string;
  /** Outcome, e.g. "8 matches". */
  result?: string;
  facts: StepFact[];
  excerpts: StepExcerpt[];
  failed: boolean;
  /** First line of the recorded error, for failed steps. */
  error?: string;
  /** The backend flagged this as an identical, already-retrieved result. */
  repeat: boolean;
  createdAt: string;
};

export type NameLookup = (sourceId: string) => string | undefined;

type Json = Record<string, unknown>;

function parse(text: string): Json | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
  } catch { return null; }
}

const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const arr = (value: unknown): unknown[] | undefined => Array.isArray(value) ? value : undefined;

export function humanizeTool(name: string): string {
  const text = name.replaceAll('_', ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Step';
}

function plural(count: number, one: string, many = `${one}s`) { return `${count.toLocaleString()} ${count === 1 ? one : many}`; }

/** 125 -> "2:05"; 3725 -> "1:02:05". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function quoted(terms: string[]): string {
  const shown = terms.slice(0, 3).map(term => `“${term}”`).join(', ');
  return terms.length > 3 ? `${shown} +${terms.length - 3}` : shown;
}

function pageList(pages: number[]): string {
  if (!pages.length) return '';
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const contiguous = sorted.every((page, index) => index === 0 || page === sorted[index - 1] + 1);
  if (sorted.length === 1) return `page ${sorted[0]}`;
  return contiguous ? `pages ${sorted[0]}–${sorted.at(-1)}` : `pages ${sorted.join(', ')}`;
}

function firstLine(text: string): string {
  const parsed = parse(text);
  const raw = str(parsed?.error) ?? text;
  const line = raw.split('\n').map(part => part.trim()).find(Boolean) ?? '';
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
}

/** Summarise one recorded action. */
export function summarizeAction(action: Action, nameOf: NameLookup = () => undefined): StepSummary {
  const args = parse(action.input) ?? {};
  const out = parse(action.output);
  const failed = action.status === 'failed';
  const sourceId = str(args.source_id) ?? str(out?.source_id);
  const sourceName = (sourceId && nameOf(sourceId)) || str(out?.name) || (sourceId ? 'a source' : undefined);
  const base: StepSummary = {
    id: action.id, name: action.name, kind: 'other', verb: humanizeTool(action.name), facts: [], excerpts: [],
    sourceIds: [...new Set([sourceId, ...(arr(out?.frames) ?? []).map(frame => str((frame as Json).source_id))].filter((id): id is string => !!id))],
    failed, repeat: !!out && 'repeat_notice' in out, createdAt: action.created_at,
  };
  if (failed) base.error = firstLine(action.output);
  const fact = (label: string, value: string | number | undefined) => { if (value !== undefined && value !== '') base.facts.push({ label, value: String(value) }); };
  const withSource = (kind: StepKind, verb: string, detail?: string): StepSummary => {
    Object.assign(base, { kind, verb, object: sourceName, sourceId, detail });
    if (sourceName) fact('Source', sourceName);
    return base;
  };

  switch (action.name) {
    case 'search_passages': {
      const terms = (arr(args.terms) ?? []).map(str).filter((term): term is string => !!term);
      base.kind = 'search'; base.verb = terms.length ? 'Searched for' : 'Searched passages';
      if (terms.length) base.object = quoted(terms);
      const matches = arr(out?.matches) ?? [];
      const total = num(out?.total);
      if (out) base.result = plural(total ?? matches.length, 'match', 'matches');
      fact('Terms', terms.join(', '));
      fact('Matches', total ?? (out ? matches.length : undefined));
      base.excerpts = matches.slice(0, 4).map(match => {
        const item = match as Json;
        return { text: str(item.excerpt) ?? '', locator: str(item.locator), title: str(item.title) };
      }).filter(excerpt => excerpt.text);
      return base;
    }
    case 'search_evidence':
    case 'search_semantic': {
      const query = str(args.query);
      const results = arr(out?.results) ?? [];
      base.kind = 'search';
      base.verb = action.name === 'search_semantic' ? (query ? 'Searched by meaning for' : 'Searched by meaning') : (query ? 'Searched sources for' : 'Searched sources');
      if (query) base.object = `“${query}”`;
      if (out) base.result = `${plural(results.length, 'result')}${out.next_offset != null ? '+' : ''}`;
      fact('Query', query);
      fact('Results', out ? results.length : undefined);
      base.excerpts = results.slice(0, 4).map(result => {
        const item = result as Json;
        return { text: str(item.excerpt) ?? '', locator: str(item.locator), title: str(item.name) };
      }).filter(excerpt => excerpt.text);
      return base;
    }
    case 'read_analysis_unit': return withSource('read', 'Read analysis input');
    case 'query_case_knowledge': base.kind = 'search'; base.verb = 'Retrieved source-linked findings'; return base;
    case 'review_saved_candidate': base.kind = 'check'; base.verb = 'Reviewed the saved answer'; return base;
    case 'read_text':
    case 'read_extract_revision': {
      const start = num(out?.start) ?? num(args.start);
      const end = num(out?.end) ?? (start !== undefined && num(args.count) ? start + num(args.count)! - 1 : undefined);
      const range = start !== undefined && end !== undefined ? (start === end ? `line ${start}` : `lines ${start}–${end}`) : undefined;
      withSource('read', 'Read', range);
      const revision = num(out?.revision) ?? num(args.revision);
      if (action.name === 'read_extract_revision' && revision !== undefined) base.detail = [range, `revision ${revision}${out?.historical ? ' (historical)' : ''}`].filter(Boolean).join(' · ');
      fact('Lines', range?.replace(/^lines? /, ''));
      fact('Revision', revision);
      fact('Total lines', num(out?.total_lines));
      return base;
    }
    case 'inspect_document_page':
    case 'inspect_document_pages': {
      const pages = (arr(args.pages) ?? [args.page]).map(num).filter((page): page is number => page !== undefined);
      withSource('look', 'Looked at', pageList(pages) ? `${pageList(pages)}` : undefined);
      fact('Pages', pages.join(', '));
      return base;
    }
    case 'inspect_image':
      withSource('look', args.crop ? 'Looked closely at part of' : 'Looked at');
      return base;
    case 'inspect_artifact_image':
      withSource('look', 'Looked at a derived image');
      return base;
    case 'inspect_video_interval': {
      const startS = num(args.start), endS = num(args.end);
      withSource('watch', 'Sampled frames from', startS !== undefined && endS !== undefined ? `${clock(startS)}–${clock(endS)}` : undefined);
      const frames = arr(out?.frames);
      if (frames) base.result = plural(frames.length, 'frame');
      if (out && out.next_start != null) base.result = [base.result, 'partly covered'].filter(Boolean).join(' · ');
      fact('Interval (s)', num(args.interval));
      fact('Frames sampled', frames?.length);
      return base;
    }
    case 'inspect_automatic_video_batch':
      base.kind = 'watch'; base.verb = 'Reviewed sampled video frames';
      if (arr(out?.frames)) base.result = plural(arr(out?.frames)!.length, 'frame');
      return base;
    case 'browse_video_overview':
      return withSource('watch', 'Browsed the overview of');
    case 'inspect_direct_media':
      // The receipt only queues the original for the next Gemini request.
      withSource('listen', 'Queued the original of', 'for the model to review');
      return base;
    case 'transcribe_audio_interval':
    case 'diarize_audio_interval': {
      const startS = num(args.start), endS = num(args.end);
      withSource('listen', action.name === 'transcribe_audio_interval' ? 'Transcribed' : 'Identified speakers in', startS !== undefined && endS !== undefined ? `${clock(startS)}–${clock(endS)}` : undefined);
      const segments = arr(out?.segments);
      if (segments) base.result = plural(segments.length, 'segment');
      base.excerpts = (segments ?? []).slice(0, 3).map(segment => ({ text: str((segment as Json).text) ?? '' })).filter(excerpt => excerpt.text);
      return base;
    }
    case 'scan_sound_events':
      return withSource('listen', 'Scanned for sounds in');
    case 'read_speaker_annotations':
      return withSource('read', 'Read speaker labels for');
    case 'list_sources': {
      base.kind = 'browse'; base.verb = 'Listed the case sources';
      const total = num(out?.total);
      if (total !== undefined) base.result = plural(total, 'source');
      return base;
    }
    case 'list_records': base.kind = 'browse'; base.verb = 'Listed working files'; return base;
    case 'list_source_artifacts': return withSource('browse', 'Listed derived files for');
    case 'list_evidence_objects': base.kind = 'browse'; base.verb = 'Listed notebook entries'; return base;
    case 'open_source': return withSource('browse', 'Opened', 'in the viewer');
    case 'process_source': return withSource('browse', 'Prepared');
    case 'queue_full_transcriptions': base.kind = 'listen'; base.verb = 'Queued full transcriptions'; return base;
    case 'recording_status':
    case 'video_discovery_status': base.kind = 'check'; base.verb = 'Checked processing status'; return base;
    case 'read_record':
      base.kind = 'read'; base.verb = 'Read working file'; base.object = str(out?.title);
      return base;
    case 'write_record': {
      base.kind = 'save';
      base.verb = args.record_id ? 'Updated working file' : 'Created working file';
      base.object = str(args.title) ? `“${str(args.title)}”` : undefined;
      fact('Reason', str(args.reason));
      fact('Revision', num(out?.revision));
      return base;
    }
    case 'save_work_product': {
      base.kind = 'save'; base.verb = `Saved ${str(args.kind) ? humanizeTool(str(args.kind)!).toLowerCase() : 'work product'}`;
      base.object = str(args.title) ? `“${str(args.title)}”` : undefined;
      return base;
    }
    case 'save_dossier': {
      base.kind = 'save'; base.verb = 'Updated the review dossier';
      fact('Checks', arr(args.checks)?.length);
      fact('Claims', arr(args.claims)?.length);
      return base;
    }
    case 'read_dossier': case 'read_prior_dossier': base.kind = 'read'; base.verb = action.name === 'read_dossier' ? 'Read the review dossier' : 'Read the previous dossier'; return base;
    case 'save_hypotheses': base.kind = 'save'; base.verb = 'Saved hypotheses'; return base;
    case 'save_observation_track': base.kind = 'save'; base.verb = 'Saved an observation track'; return base;
    case 'save_coverage_contract': base.kind = 'save'; base.verb = 'Saved the coverage plan'; return base;
    case 'read_coverage': base.kind = 'check'; base.verb = 'Checked review coverage'; return base;
    case 'fit_clock_anchors': base.kind = 'check'; base.verb = 'Aligned recording clocks'; return base;
    case 'record_visual_observations': {
      const count = arr(args.observations)?.length ?? 0;
      base.kind = 'save'; base.verb = count ? `Recorded ${plural(count, 'visual observation')}` : 'Recorded visual observations';
      return base;
    }
    case 'read_evidence_object': base.kind = 'read'; base.verb = 'Read a notebook entry'; return base;
    case 'write_evidence_object': base.kind = 'save'; base.verb = 'Saved a notebook entry'; return base;
    case 'read_artifact': base.kind = 'read'; base.verb = 'Read a derived file'; return base;
    case 'read_conversation': base.kind = 'read'; base.verb = 'Read the earlier conversation'; return base;
    case 'read_receipt': case 'read_tool_result': base.kind = 'read'; base.verb = 'Re-read an earlier result'; return base;
    case 'validate_citation': {
      base.kind = 'check'; base.verb = 'Checked a citation in';
      base.object = str(out?.name) ?? sourceName ?? 'a source';
      if (out && typeof out.valid === 'boolean') base.result = out.valid ? 'valid' : 'not valid';
      fact('Citation', str(args.citation));
      fact('Revision binding', str(out?.revision_binding));
      return base;
    }
    case 'checkpoint_review': {
      base.kind = 'save'; base.verb = 'Saved progress';
      fact('Summary', str(args.summary));
      fact('Next steps', arr(args.next_steps)?.length);
      return base;
    }
    case 'request_more_research': base.kind = 'team'; base.verb = 'Requested more research'; return base;
    case 'review_candidate': base.kind = 'check'; base.verb = 'Reviewed a candidate answer'; return base;
    case 'list_agent_models': base.kind = 'team'; base.verb = 'Checked available models'; return base;
    case 'delegate_tasks': {
      const count = arr(args.assignments)?.length ?? 0;
      base.kind = 'team'; base.verb = count ? `Asked ${plural(count, 'team member')}` : 'Delegated work';
      return base;
    }
    case 'finish_inventory': base.kind = 'finish'; base.verb = 'Finished the inventory'; return base;
    case 'finish_task': {
      base.kind = 'finish';
      const status = str(out?.status);
      base.verb = status === 'review_required' ? 'Sent the answer for review' : status === 'team_review_pending' ? 'Waiting for team review' : 'Prepared the answer';
      const cited = num(out?.citation_count) ?? arr(args.citations)?.length;
      if (cited) base.result = plural(cited, 'citation');
      fact('Gaps noted', arr(args.gaps)?.length);
      return base;
    }
    default:
      if (sourceName) { base.object = sourceName; base.sourceId = sourceId; fact('Source', sourceName); }
      return base;
  }
}

/** Present-tense label for a tool the model has just requested (live stream). */
export function liveLabel(toolName: string | undefined): string {
  const name = (toolName ?? '').replaceAll(' ', '_');
  if (!name) return 'Working';
  if (/^search/.test(name)) return 'Searching the evidence';
  if (/^(read_text|read_extract)/.test(name)) return 'Reading';
  if (/^read|^list/.test(name)) return 'Looking things up';
  if (/document_page|image/.test(name)) return 'Looking at the document';
  if (/video|frame/.test(name)) return 'Sampling video frames';
  if (/transcribe/.test(name)) return 'Transcribing audio';
  if (/diariz|sound|audio|media/.test(name)) return 'Working with the recording';
  if (/validate|coverage|check|review_candidate/.test(name)) return 'Checking citations';
  if (/^(write|save|record)/.test(name) || name === 'checkpoint_review') return 'Saving notes';
  if (/delegate|team|research/.test(name)) return 'Briefing the team';
  if (/finish/.test(name)) return 'Preparing the answer';
  return humanizeTool(name);
}

/** Present-tense label for the step in progress, from the newest recorded step. */
export function progressLabel(step: StepSummary | undefined): string {
  if (!step) return 'Considering the evidence';
  const map: Record<StepKind, string> = {
    search: 'Searching the evidence', read: step.object ? `Reading ${step.object}` : 'Reading', look: step.object ? `Looking at ${step.object}` : 'Looking at the document',
    watch: 'Sampling video frames', listen: 'Working with the recording', save: 'Saving notes', check: 'Checking the work', team: 'Working with the team',
    finish: 'Preparing the answer', browse: 'Looking things up', other: 'Working',
  };
  return map[step.kind];
}

export type StepGroup = { kind: StepKind; steps: StepSummary[] };

/** Runs of three or more consecutive, successful steps of one kind collapse into a group. */
export function groupSteps(steps: StepSummary[], keepLastOpen = false): (StepSummary | StepGroup)[] {
  const out: (StepSummary | StepGroup)[] = [];
  let index = 0;
  while (index < steps.length) {
    const kind = steps[index].kind;
    let end = index;
    while (end + 1 < steps.length && steps[end + 1].kind === kind && !steps[end + 1].failed && !steps[index].failed) end += 1;
    const run = steps.slice(index, end + 1);
    const isTail = end === steps.length - 1;
    if (run.length >= 3 && kind !== 'other' && !(keepLastOpen && isTail)) out.push({ kind, steps: run });
    else out.push(...run);
    index = end + 1;
  }
  return out;
}

export function isGroup(item: StepSummary | StepGroup): item is StepGroup { return 'steps' in item; }

export function groupLabel(group: StepGroup): string {
  const sources = new Set(group.steps.map(step => step.sourceId).filter(Boolean)).size;
  const count = group.steps.length;
  switch (group.kind) {
    case 'search': return `Ran ${plural(count, 'search', 'searches')}`;
    case 'read': return sources > 1 ? `Read ${plural(sources, 'source')}` : `Read ${plural(count, 'passage')}`;
    case 'look': return sources > 1 ? `Looked at ${plural(sources, 'document')}` : `Looked at ${plural(count, 'page view')}`;
    case 'watch': return `Sampled frames from ${plural(count, 'video segment')}`;
    case 'listen': return group.steps.every(step => step.name === 'transcribe_audio_interval') ? `Transcribed ${plural(count, 'audio segment')}` : `${plural(count, 'audio step')}`;
    case 'save': return `Saved ${plural(count, 'note')}`;
    case 'check': return `Ran ${plural(count, 'check')}`;
    default: return `${plural(count, 'step')}`;
  }
}

/** One-line recap of a finished trace, e.g. "3 searches · read 4 sources · 1 failed". */
export function traceRecap(steps: StepSummary[]): string {
  if (!steps.length) return 'No recorded actions';
  const searches = steps.filter(step => step.kind === 'search' && !step.failed).length;
  const consulted = new Set(steps.filter(step => ['read', 'look', 'watch', 'listen'].includes(step.kind) && !step.failed).flatMap(step => step.sourceIds ?? (step.sourceId ? [step.sourceId] : []))).size;
  const saved = steps.filter(step => step.kind === 'save' && !step.failed).length;
  const checks = steps.filter(step => step.kind === 'check' && !step.failed).length;
  const failed = steps.filter(step => step.failed).length;
  const parts = [
    searches ? plural(searches, 'search', 'searches') : '',
    consulted ? `consulted ${plural(consulted, 'source')}` : '',
    checks ? plural(checks, 'check') : '',
    saved ? `saved ${plural(saved, 'note')}` : '',
  ].filter(Boolean);
  if (!parts.length) parts.push(plural(steps.length - failed, 'action'));
  if (failed) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/** "Worked for 1m 12s" style duration; under a minute reads "Worked for 42s". */
export function workedFor(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const m = Math.floor(whole / 60), s = whole % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
