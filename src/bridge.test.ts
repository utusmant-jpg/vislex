import { describe, expect, it } from 'vitest';
import { citationParts, api, sampleSnapshot } from './bridge';
describe('evidence links', () => {
  it('accepts exact typed locators, never filesystem or executable links', () => {
    expect(citationParts('evidence:abc-123#L1-L5')).toEqual({ sourceId: 'abc-123', locator: 'L1-L5' });
    for (const bad of ['javascript:alert(1)', 'file:///C:/secret', 'evidence:../../secret#image', 'evidence:abc#unknown']) expect(citationParts(bad)).toBeNull();
  });
  // R02 — the revision-pinned citation grammar shared with the Rust resolver.
  // Same fixtures as the Rust suite: pinned, legacy, and rejected forms.
  it('accepts revision-pinned locators and rejects malformed grammar', () => {
    expect(citationParts('evidence:abc-123#R1L1-L3')).toEqual({ sourceId: 'abc-123', locator: 'R1L1-L3' });
    expect(citationParts('evidence:abc-123#R12L45-L47')).toEqual({ sourceId: 'abc-123', locator: 'R12L45-L47' });
    for (const bad of [
      'evidence:abc-123#r1L1-L3',       // lowercase revision marker
      'evidence:abc-123#R1L1',          // missing end line
      'evidence:abc-123#R1L1-3',        // missing L on the end line
      'evidence:abc-123#RL1-L3',        // missing revision number
      'evidence:abc-123#R1.5L1-L3',     // fractional revision
      'evidence:abc-123#R-1L1-L3',      // negative revision
      'evidence:abc-123#R+1L1-L3',      // signed revision
      'evidence:abc-123#R01L1-L3',      // leading-zero revision
      'evidence:abc-123#R1L01-L3',      // leading-zero line
      'evidence:abc-123#R1L0-L3',       // line zero
    ]) expect(citationParts(bad)).toBeNull();
  });
});
describe('browser preview isolation', () => {
  it('is synthetic, read-only to host, and never dispatches paid API tasks', async () => {
    await api('load_demo');
    expect(sampleSnapshot().settings.offline).toBe(true);
    await expect(api('start_task', { prompt: 'Investigate' })).rejects.toThrow('native desktop');
    await expect(api('import_files', { paths: ['C:\\private.txt'] })).rejects.toThrow('native desktop');
  });
  it('rejects stale edits', async () => {
    await api('load_demo');
    await expect(api('write_record', { record_id: 'demo-note', base_revision: 0 })).rejects.toThrow('changed');
  });
  it('serves demo text with a revision-pinned locator', async () => {
    await api('load_demo');
    const page = await api<{ locator: string; revision: number }>('read_text', { source_id: 'demo-statement', start: 5, count: 3 });
    expect(page.revision).toBe(1);
    expect(page.locator).toBe('evidence:demo-statement#R1L5-L7');
  });
  it('provides a stable case-scoped summary and advances it after memory-only edits', async () => {
    await api('load_demo');
    const before = await api<{ case_id: string; audit_seq: number; source_count: number }>('case_summary', { case_id: 'synthetic-demo' });
    expect(before).toMatchObject({ case_id: 'synthetic-demo', audit_seq: 0, source_count: 1 });
    expect(await api('case_summary', { case_id: 'synthetic-demo' })).toEqual(before);
    await expect(api('case_summary', { case_id: 'other-case' })).rejects.toThrow('Case changed');
    await api('write_record', { case_id: 'synthetic-demo', record_id: 'demo-note', base_revision: 1, title: 'Initial review notes', kind: 'note', content: 'Synthetic edit', source_ids: [] });
    const after = await api<{ audit_seq: number }>('case_summary', { case_id: 'synthetic-demo' });
    expect(after.audit_seq).toBe(before.audit_seq + 1);
  });
  it('provides synthetic review reads but keeps native review actions unavailable', async () => {
    await api('load_demo');
    expect(await api('investigation_workbench')).toMatchObject({ investigations: [], affected_objects: [] });
    expect(await api<{ sources: { source_id: string }[] }>('coverage_map')).toMatchObject({ sources: [{ source_id: 'demo-statement' }] });
    await expect(api('review_redaction', { artifact_id: 'fake' })).rejects.toThrow('native desktop');
  });
});
