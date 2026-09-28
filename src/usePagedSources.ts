import { useEffect, useRef, useState } from 'react';
import { api } from './bridge';
import type { Snapshot, Source } from './types';

/** Load older source summaries only when a source picker needs them. */
export function usePagedSources(snapshot: Snapshot) {
  const [older, setOlder] = useState<Source[]>([]);
  const [cursor, setCursor] = useState<{ created_at: string; id: string } | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const key = `${snapshot.id}:${snapshot.generation}:${snapshot.counts?.audit_seq ?? 0}`;
  const keyRef = useRef(key); keyRef.current = key;
  useEffect(() => { setOlder([]); setCursor(undefined); setError(''); }, [key]);
  const sources = [...snapshot.sources, ...older.filter(source => !snapshot.sources.some(current => current.id === source.id))];
  const hasMore = cursor !== null && sources.length < (snapshot.counts?.source_count ?? sources.length);
  async function loadMore() {
    if (loading || !hasMore) return;
    const before = cursor ?? snapshot.source_next_cursor ?? (snapshot.sources.at(-1) ? { created_at: snapshot.sources.at(-1)!.created_at, id: snapshot.sources.at(-1)!.id } : null);
    if (!before) return;
    const expected = key;
    setLoading(true); setError('');
    try {
      const page = await api<{ sources: Source[]; next_cursor: { created_at: string; id: string } | null }>('source_page', { case_id: snapshot.id, generation: snapshot.generation, audit_seq: snapshot.counts?.audit_seq ?? 0, before });
      if (keyRef.current !== expected) return;
      setOlder(current => [...current, ...page.sources.filter(source => !current.some(existing => existing.id === source.id))]);
      setCursor(page.next_cursor);
    } catch (reason) { if (keyRef.current === expected) setError(String(reason)); }
    finally { if (keyRef.current === expected) setLoading(false); }
  }
  return { sources, hasMore, loading, error, loadMore };
}
