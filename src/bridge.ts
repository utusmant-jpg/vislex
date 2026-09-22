import { invoke, isTauri, convertFileSrc } from '@tauri-apps/api/core';

import type { Snapshot, Source, WorkingRecord } from './types';



export const native = typeof window !== 'undefined' && isTauri();

const sampleText = `SYNTHETIC DEMONSTRATION — NOT REAL EVIDENCE

Incident review / Harbor Street

Prepared for software testing only.



At approximately 14:32, a witness reported seeing two people near the north entrance.

The witness described one person carrying a blue bag.

The statement does not identify either person by name.



The camera's displayed clock has not been reconciled to a reference clock.

The recorded time must not be treated as verified real-world time.



Review questions

1. Can the number of people be corroborated by visual evidence?

2. Does the blue object appear in more than one source?

3. What uncertainty remains in the reported time?



This fixture demonstrates source-linked review, not a factual case conclusion.`;

const at = '2026-09-20T14:32:00Z';

const demoSource: Source = { id: 'demo-statement', name: '01 · Witness statement.txt', sha256: 'synthetic-preview-not-a-source-hash', size: sampleText.length, mime: 'text/plain', kind: 'text', status: 'text indexed', restricted: false, occurrences: 1, created_at: at };

let demo: Snapshot | null = null;

export function sampleSnapshot(): Snapshot {

  return { id: 'synthetic-demo', name: 'Harbor Street · sample case', root: 'Browser memory — no files stored', generation: 1, sources: [demoSource], records: [{ id: 'demo-note', title: 'Initial review notes', kind: 'note', content: '# Initial review\n\nThe witness statement reports two people near the north entrance. This is an attributed claim, not an independently verified observation.\n\nSource: evidence:demo-statement#L5-L7\n\n## Open questions\n\n- Obtain the original recording.\n- Reconcile the camera clock.\n- Inspect any supporting photographs.\n\nSynthetic demonstration only.', revision: 1, actor: 'human', review: 'unreviewed', protected: false, stale: false, updated_at: at, dependencies: ['demo-statement'] }], settings: { offline: true, allow_text: false, allow_images: false, model: '', case_budget: 10, input_per_million: 0, output_per_million: 0 }, tasks: [], budget_committed: 0 };

}

export async function api<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {

  if (native) return invoke<T>('command', { action, args });

  let result: unknown;

  if (action === 'snapshot') result = demo;

  else if (action === 'load_demo') { demo = sampleSnapshot(); result = demo; }

  else if (action === 'close_case') { demo = null; result = null; }

  else if (action === 'ai_config') result = { provider: 'openai', execution: 'single', review: 'standard', pool: [] };
  else if (action === 'team_status') result = [];
  else if (action === 'provider_key_status') result = { configured: false };
  else if (action === 'key_status') result = { configured: false };

  else if (!demo) throw new Error('Open the synthetic sample, or run the desktop app for real case storage.');

  else if (action === 'read_text') { const lines = sampleText.split('\n'); const start = Number(args.start ?? 1); const end = Math.min(start - 1 + Number(args.count ?? 200), lines.length); result = { text: lines.slice(start - 1, end).join('\n'), start, end, total_lines: lines.length, revision: 1, locator: `evidence:demo-statement#R1L${start}-L${end}`, truncated_long_lines: false }; }

  else if (action === 'search') { result = { results: sampleText.toLowerCase().includes(String(args.query).toLowerCase()) ? [{ source_id: demoSource.id, name: demoSource.name, excerpt: sampleText.split('\n').filter(s => s.toLowerCase().includes(String(args.query).toLowerCase())).join(' … ') }] : [], next_offset: null }; }

  else if (action === 'write_record') {

    const old = demo.records.find(r => r.id === args.record_id);

    if (old && old.revision !== args.base_revision) throw new Error('This record changed. Reload before saving.');

    const record: WorkingRecord = { id: old?.id ?? crypto.randomUUID(), title: String(args.title), kind: String(args.kind), content: String(args.content), revision: Number(args.base_revision) + 1, actor: 'human', review: 'unreviewed', protected: old?.protected ?? false, stale: false, updated_at: new Date().toISOString(), dependencies: args.source_ids as string[] ?? [] };

    demo.records = [record, ...demo.records.filter(r => r.id !== record.id)]; result = record;

  } else if (action === 'set_restricted') { demo.sources = demo.sources.map(s => s.id === args.source_id ? { ...s, restricted: Boolean(args.restricted) } : s); }

  else if (action === 'review_record') { demo.records = demo.records.map(r => r.id === args.record_id ? { ...r, ...(typeof args.protected === 'boolean' ? { protected: args.protected } : { review: 'human-reviewed' }) } : r); }

  else if (action === 'save_ai_settings') { throw new Error('AI configuration requires the Windows desktop app.'); }
  else if (action === 'save_settings') { demo.settings = args.settings as Snapshot['settings']; }

  else if (action === 'revisions') { const r = demo.records.find(r => r.id === args.record_id); result = r ? [{ ...r, reason: 'Browser sample — history is not persisted', created_at: r.updated_at }] : []; }

  else if (action === 'read_extract_revision') { if (Number(args.revision) !== 1) throw new Error('Unknown extraction revision'); const lines = sampleText.split('\n'); const start = Number(args.start ?? 1); const end = Math.min(start - 1 + Number(args.count ?? 200), lines.length); result = { text: lines.slice(start - 1, end).join('\n'), start, end, total_lines: lines.length, revision: 1, historical: true, truncated_long_lines: false, locator: `evidence:demo-statement#R1L${start}-L${end}` }; }

  else if (action === 'actions') result = [];

  else throw new Error('This operation requires the native desktop app. The browser sample never accesses files or sends evidence.');

  return structuredClone(result) as T;

}

export function evidenceUrl(id: string) { return native ? convertFileSrc(id, 'evidence') : ''; }

export function formatBytes(bytes: number) { if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }

export function citationParts(value: string): { sourceId: string; locator: string } | null {

  const match = /^evidence:([a-zA-Z0-9-]+)#(R[1-9]\d*L[1-9]\d*-L[1-9]\d*|L\d+-L\d+|image|media|artifact:[a-zA-Z0-9-]+)$/.exec(value);

  return match ? { sourceId: match[1], locator: match[2] } : null;

}

