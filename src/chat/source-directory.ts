// Display names for sources referenced by answers and activity. The loaded case
// page answers most lookups; anything else is fetched once with source_detail
// and cached per case session. Names only: no case content is stored.
import { useCallback, useEffect, useReducer } from 'react';
import { api, native } from '../bridge';
import { caseSessionArgs } from '../caseSession';
import type { Snapshot, Source } from '../types';
import type { SourceInfo } from './citation-context';

type Entry = SourceInfo | 'pending' | 'missing';
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

export function useSourceDirectory(snapshot: Snapshot | null): (sourceId: string) => SourceInfo | undefined {
  const [version, bump] = useReducer((value: number) => value + 1, 0);
  useEffect(() => { listeners.add(bump); return () => { listeners.delete(bump); }; }, []);
  const caseId = snapshot?.id;
  const epoch = snapshot?.session_epoch;
  const sources = snapshot?.sources;
  return useCallback((sourceId: string) => {
    const loaded = sources?.find(source => source.id === sourceId);
    if (loaded) return { name: loaded.name, kind: loaded.kind, restricted: loaded.restricted };
    if (!caseId) return undefined;
    const key = `${caseId}:${epoch ?? ''}:${sourceId}`;
    const entry = cache.get(key);
    if (entry && typeof entry === 'object') return entry;
    if (!entry && native) {
      cache.set(key, 'pending');
      queueMicrotask(() => {
        api<Source>('source_detail', { ...caseSessionArgs(caseId, epoch), source_id: sourceId })
          .then(source => { cache.set(key, source?.name ? { name: source.name, kind: source.kind, restricted: !!source.restricted } : 'missing'); notify(); })
          .catch(() => { cache.set(key, 'missing'); notify(); });
      });
    }
    return undefined;
    // version re-creates the lookup after a fetch lands so consumers re-render.
  }, [caseId, epoch, sources, version]);
}
