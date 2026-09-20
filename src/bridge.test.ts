import { describe, expect, it } from 'vitest';
import { citationParts, api, sampleSnapshot } from './bridge';
describe('evidence links', () => {
  it('accepts exact typed locators, never filesystem or executable links', () => {
    expect(citationParts('evidence:abc-123#L1-L5')).toEqual({ sourceId: 'abc-123', locator: 'L1-L5' });
    for (const bad of ['javascript:alert(1)', 'file:///C:/secret', 'evidence:../../secret#image', 'evidence:abc#unknown']) expect(citationParts(bad)).toBeNull();
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
});
