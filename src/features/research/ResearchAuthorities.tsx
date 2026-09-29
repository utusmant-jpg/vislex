import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, ExternalLink, Flag, FlagOff, CircleHelp } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { api, native } from '../../bridge';
import { caseSessionArgs } from '../../caseSession';
import { CitationChip, StatusPill, notify } from '../../ui';
import { isResearchAuthority, parseAuthority } from './ResearchCiteCheck';
import { errorText, researchPaneNavigate } from './api';

export const AUTHORITIES_OPEN_KEY = 'vislex.research.authoritiesOpen';
/** Pages of evidence_list read at most (50 objects each). */
const MAX_PAGES = 20;

type EvidenceObject = { id: string; revision: number; kind: string; title: string; content: string; source_ids: string[]; locators: string[]; review: string; stale: boolean; actor: string };
type Page = { objects: EvidenceObject[]; next_offset: number | null };

export type KeyCiteFlag = 'red' | 'yellow' | 'blue_striped' | 'orange' | 'none' | 'unknown';
/** Each flag's visible name and its meaning, read with the name (never colour alone). */
export const KEYCITE_FLAGS: Record<KeyCiteFlag, { label: string; meaning: string }> = {
  red: { label: 'Red flag', meaning: 'no longer good law for at least one point' },
  yellow: { label: 'Yellow flag', meaning: 'some negative history' },
  blue_striped: { label: 'Blue-striped flag', meaning: 'appealed to a higher court' },
  orange: { label: 'Orange flag', meaning: 'relies on authority that was overruled or questioned' },
  none: { label: 'No flag', meaning: 'no negative history shown' },
  unknown: { label: 'Not checked', meaning: 'KeyCite status not recorded' },
};

export function keyCiteFlag(content: string): KeyCiteFlag {
  const value = parseAuthority(content) as { keycite?: { flag?: unknown } } | null;
  const flag = value?.keycite?.flag;
  return typeof flag === 'string' && flag in KEYCITE_FLAGS ? flag as KeyCiteFlag : 'unknown';
}

export function KeyCitePill({ flag }: { flag: KeyCiteFlag }) {
  const { label, meaning } = KEYCITE_FLAGS[flag];
  const Icon = flag === 'none' ? FlagOff : flag === 'unknown' ? CircleHelp : Flag;
  return <span className={`keycite-pill keycite-${flag}`} role="img" aria-label={`KeyCite: ${label}, ${meaning}`} title={`KeyCite: ${meaning}`}>
    <Icon size={12} aria-hidden="true" className="keycite-icon" />
    <span aria-hidden="true">{label}</span>
  </span>;
}

/** The review state, as the Evidence notebook shows it (kept here so that lazily loaded view stays split). */
function reviewPill(object: Pick<EvidenceObject, 'review' | 'stale'>) {
  if (object.stale) return <StatusPill state="stale" label="Recheck dependencies" small />;
  if (object.review === 'accepted') return <StatusPill state="accepted" label="Accepted" small />;
  if (object.review === 'rejected') return <StatusPill state="failed" label="Rejected" small />;
  return <StatusPill state="unreviewed" label="Unreviewed" small />;
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

function readOpen() {
  try { return window.localStorage.getItem(AUTHORITIES_OPEN_KEY) === '1'; } catch { return false; }
}
function saveOpen(open: boolean) {
  try { window.localStorage.setItem(AUTHORITIES_OPEN_KEY, open ? '1' : '0'); } catch { /* A per-device convenience only. */ }
}

/**
 * The authorities captured from the research browser in this case (evidence objects of kind
 * "authority" recorded by the research browser adapter), read through evidence_list like the
 * Evidence notebook and refreshed whenever the case changes.
 */
export default function ResearchAuthorities({ caseId, sessionEpoch, onSource, canOpenPage }: {
  caseId: string;
  sessionEpoch?: number;
  /** Opens a cited source at its locator (the chat's citation opener). */
  onSource?: (sourceId: string, locator?: string) => void;
  /** True while the research browser is open, so a captured page can be shown in it. */
  canOpenPage?: boolean;
}) {
  const [open, setOpen] = useState(readOpen);
  const [items, setItems] = useState<EvidenceObject[] | null>(null);
  const [error, setError] = useState('');
  const listId = useId();
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!native) { setItems([]); return; }
    const seq = ++request.current;
    try {
      const found: EvidenceObject[] = [];
      let offset: number | null = 0;
      for (let page = 0; page < MAX_PAGES && offset !== null; page += 1) {
        const result: Page = await api<Page>('evidence_list', { ...caseSessionArgs(caseId, sessionEpoch), kind: 'authority', offset });
        found.push(...(result?.objects ?? []).filter(isResearchAuthority));
        offset = result?.next_offset ?? null;
      }
      if (seq === request.current) { setItems(found); setError(''); }
    } catch (failure) {
      if (seq === request.current) setError(errorText(failure));
    }
  }, [caseId, sessionEpoch]);

  useEffect(() => {
    void load();
    if (!native) return;
    let active = true;
    let timer = 0;
    // Every case mutation (a capture, a review) is followed by case-changed.
    const stop = listen('case-changed', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (active) void load(); }, 60);
    }).catch(() => null);
    return () => { active = false; request.current += 1; window.clearTimeout(timer); void stop.then(unlisten => unlisten?.()); };
  }, [load]);

  const toggle = () => setOpen(current => { saveOpen(!current); return !current; });
  const count = items?.length ?? 0;

  return <section className={`research-authorities ${open ? 'is-open' : ''}`} aria-labelledby={`${listId}-heading`}>
    <h3 className="research-authorities-heading" id={`${listId}-heading`}>
      <button type="button" className="research-authorities-toggle" aria-expanded={open} aria-controls={listId} onClick={toggle}>
        <ChevronRight size={14} aria-hidden="true" className="research-authorities-chevron" />
        Authorities
        <span className="research-authorities-count">{items ? count.toLocaleString() : '…'}</span>
      </button>
    </h3>
    <div id={listId} className="research-authorities-body" hidden={!open}>
      {error ? <p className="small danger-text" role="alert">{error}</p>
        : items === null ? <p className="field-hint" aria-busy="true">Loading…</p>
        : !items.length ? <p className="field-hint">No authorities captured yet.</p>
        : <ul className="research-authorities-list" aria-label="Captured authorities">
          {items.map(item => <AuthorityRow key={`${item.id}:${item.revision}`} item={item} onSource={onSource} canOpenPage={!!canOpenPage} />)}
        </ul>}
    </div>
  </section>;
}

function AuthorityRow({ item, onSource, canOpenPage }: { item: EvidenceObject; onSource?: (sourceId: string, locator?: string) => void; canOpenPage: boolean }) {
  const value = parseAuthority(item.content) as (ReturnType<typeof parseAuthority> & { jurisdiction?: string; court?: string }) | null;
  const title = text(value?.title) || item.title || 'Untitled authority';
  const citation = text(value?.citation?.raw) || text(value?.citation?.claimed);
  const court = [text(value?.court), text(value?.jurisdiction)].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ');
  const url = text(value?.url);
  const locator = item.locators[0] ?? text(value?.quote?.locator);
  async function openPage() {
    try { await researchPaneNavigate(url); }
    catch (failure) { notify.fromError('The research browser could not open that page', failure); }
  }
  return <li className="research-authority-row">
    <div className="research-authority-main">
      <span className="research-authority-title">{title}</span>
      <span className="research-authority-meta">
        {citation ? <span className="research-authority-citation">{citation}</span> : null}
        {court ? <span>{court}</span> : null}
      </span>
    </div>
    <div className="research-authority-tags">
      <KeyCitePill flag={keyCiteFlag(item.content)} />
      {reviewPill(item)}
    </div>
    <div className="research-authority-actions">
      {onSource && locator.startsWith('evidence:') ? <CitationChip value={locator} onOpen={(sourceId, at) => onSource(sourceId, at)} /> : null}
      {url && canOpenPage ? <button type="button" className="quiet" data-size="sm" aria-label={`Show page: ${title}`} onClick={() => void openPage()}>
        <ExternalLink size={13} aria-hidden="true" />Show page
      </button> : null}
    </div>
  </li>;
}
