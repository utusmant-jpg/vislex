import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, Lock, LogOut, Power, RefreshCw, RotateCw, Square, WifiOff, X } from 'lucide-react';
import { native } from '../../bridge';
import { notify } from '../../ui';
import {
  RESEARCH_GRANT_CHANGED, clearResearchSession, closeResearchPane, errorText, layoutResearchPane, openResearchPane,
  rectOf, researchGrant, researchPaneHistory, researchPaneState, researchStop, setResearchGrant, type PaneRect, type ResearchGrant, type ResearchPaneState,
} from './api';

export const PANE_STATE_POLL_MS = 1500;

type Phase = 'closed' | 'opening' | 'open';

/** True while any <dialog> is open. The research webview is a native layer above
 *  the whole page, so it must not cover a dialog (Settings, palette, confirmations). */
function dialogOpen() {
  return document.querySelector('dialog[open]') !== null;
}

/**
 * The right half of the research split view: a slim toolbar above an empty slot
 * that the native research webview is placed over. The slot's position is sent
 * with research_pane_layout whenever it moves or resizes; the webview is hidden
 * when the slot unmounts, collapses, is suspended, or a dialog is open.
 */
export default function BrowserPane({ caseId, sessionEpoch, offline = false, suspended = false, onOpenSettings }: {
  caseId: string;
  sessionEpoch?: number;
  /** The case's saved offline setting. */
  offline?: boolean;
  /** Temporarily hide the native pane (for example while an overlay covers this area). */
  suspended?: boolean;
  onOpenSettings: (section: 'Research browser' | 'Privacy & offline') => void;
}) {
  const slot = useRef<HTMLDivElement | null>(null);
  // The slot as state too: placement must start when the slot appears, which can be after the
  // pane is already known to be open (returning to the view with the pane still open).
  const [slotElement, setSlotElement] = useState<HTMLDivElement | null>(null);
  const attachSlot = useCallback((element: HTMLDivElement | null) => { slot.current = element; setSlotElement(element); }, []);
  const [grant, setGrant] = useState<ResearchGrant | null>(null);
  const [grantLoaded, setGrantLoaded] = useState(false);
  const [phase, setPhase] = useState<Phase>('closed');
  const [pane, setPane] = useState<ResearchPaneState | null>(null);
  const [openError, setOpenError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusedOffline, setRefusedOffline] = useState(false);
  const autoOpened = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const enabled = !!grant?.enabled;
  const isOffline = offline || refusedOffline;

  // The case's grant: loaded on mount and whenever Settings (or this pane) changes it.
  useEffect(() => {
    if (!native) { setGrantLoaded(true); return; }
    let active = true;
    const load = () => researchGrant(caseId, sessionEpoch)
      .then(value => { if (active) { setGrant(value); setLoadError(''); setGrantLoaded(true); } })
      .catch(error => { if (active) { setGrantLoaded(true); setLoadError(errorText(error)); } });
    void load();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ caseId: string; grant: ResearchGrant }>).detail;
      if (detail?.caseId === caseId) { setGrant(detail.grant); setLoadError(''); }
    };
    window.addEventListener(RESEARCH_GRANT_CHANGED, changed);
    return () => { active = false; window.removeEventListener(RESEARCH_GRANT_CHANGED, changed); };
  }, [caseId, sessionEpoch]);
  useEffect(() => { if (!offline) setRefusedOffline(false); }, [offline]);

  const open = useCallback(async () => {
    const element = slot.current;
    if (!element) return;
    setPhase('opening'); setOpenError('');
    try {
      await openResearchPane(caseId, sessionEpoch, rectOf(element));
      if (live.current) setPhase('open');
    } catch (error) {
      if (!live.current) return;
      const message = errorText(error);
      setPhase('closed');
      if (/offline/i.test(message)) setRefusedOffline(true); else setOpenError(message);
    }
  }, [caseId, sessionEpoch]);

  // Opening the view opens the browser once, when the case allows it; a pane already
  // open for this case (from an earlier visit to the view) is placed, not reopened.
  useEffect(() => {
    if (!grantLoaded || !enabled || isOffline || autoOpened.current) return;
    autoOpened.current = true;
    researchPaneState()
      .then(state => { if (!live.current) return; if (state.open && state.case_id === caseId) { setPane(state); setPhase('open'); } else void open(); })
      .catch(() => { if (live.current) void open(); });
  }, [grantLoaded, enabled, isOffline, open, caseId]);

  // Follow the pane's real state: the backend closes it when the case switches,
  // goes offline, or research is switched off or reconfigured.
  useEffect(() => {
    if (!native) return;
    let active = true;
    const poll = () => researchPaneState().then(state => {
      if (!active) return;
      setPane(state);
      const ours = state.open && (!state.case_id || state.case_id === caseId);
      setPhase(current => current === 'opening' ? current : ours ? 'open' : 'closed');
    }).catch(() => { /* A failed poll keeps the last known state. */ });
    void poll();
    const timer = window.setInterval(poll, PANE_STATE_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [caseId]);

  // Placement: every move or resize of the slot, window resizes, dialogs opening or closing.
  useEffect(() => {
    if (phase !== 'open') return;
    const element = slotElement;
    if (!element) return;
    let frame = 0;
    let last = '';
    let lastRect: PaneRect = rectOf(element);
    const send = () => {
      frame = 0;
      const rect = rectOf(element);
      const visible = !suspended && !dialogOpen() && rect.width > 0 && rect.height > 0;
      const key = `${rect.x},${rect.y},${rect.width},${rect.height},${visible}`;
      if (key === last) return;
      last = key;
      if (rect.width > 0 && rect.height > 0) lastRect = rect;
      layoutResearchPane(visible ? rect : lastRect, visible).catch(() => { /* The pane may have just closed; polling reconciles. */ });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(send); };
    send();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(element);
    window.addEventListener('resize', schedule);
    const dialogs = new MutationObserver(schedule);
    dialogs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      window.removeEventListener('resize', schedule);
      dialogs.disconnect();
      layoutResearchPane(lastRect, false).catch(() => { /* Already closed. */ });
    };
  }, [phase, suspended, slotElement]);

  async function turnOn() {
    setBusy(true);
    try {
      const next = await setResearchGrant(caseId, sessionEpoch, true);
      if (live.current) setGrant(next);
    } catch (error) {
      notify.fromError('Could not turn on the research browser', error);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  function history(action: 'back' | 'forward' | 'reload') {
    researchPaneHistory(action).catch(error => notify.fromError('The research browser could not do that', error));
  }
  // Stops the agent's work in the page: the backend pauses the task holding the research page
  // and stops the page loading. The chat's own Stop is unchanged.
  const [stopping, setStopping] = useState(false);
  async function stop() {
    // aria-disabled rather than disabled while a stop is in flight, so keyboard focus stays here.
    if (stopping) return;
    setStopping(true);
    try {
      const result = await researchStop(caseId, sessionEpoch);
      if (!result?.stopped) notify.info('No research task is running', 'The page stopped loading; nothing else was running.');
    }
    catch (error) { notify.fromError('Could not stop the research browser', error); }
    finally { if (live.current) setStopping(false); }
  }
  async function close() {
    setBusy(true);
    try { await closeResearchPane(); if (live.current) setPhase('closed'); }
    catch (error) { notify.fromError('Could not close the research browser', error); }
    finally { if (live.current) setBusy(false); }
  }
  async function signOut() {
    setBusy(true);
    try {
      await clearResearchSession();
      if (live.current) { setPhase('closed'); setPane(null); }
      notify.success('Signed out of the research browser', 'Its saved session was cleared from this computer.');
    } catch (error) {
      notify.fromError('Could not sign out of the research browser', error);
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const host = phase === 'open' ? pane?.host ?? null : null;
  const secure = phase === 'open' && pane?.secure === true;
  const statusLabel = phase === 'open' ? 'Connected' : phase === 'opening' ? 'Opening…' : 'Closed';

  let body;
  if (!native) {
    body = <div className="empty-state research-empty">
      <Globe size={20} aria-hidden="true" />
      <h3>Research browser</h3>
      <p>The research browser is available in the Windows desktop app.</p>
    </div>;
  } else if (!grantLoaded) {
    body = <div className="empty-state research-empty" aria-busy="true"><p className="field-hint">Loading…</p></div>;
  } else if (isOffline) {
    body = <div className="empty-state research-empty">
      <WifiOff size={20} aria-hidden="true" />
      <h3>This case is offline</h3>
      <p>The research browser needs the case online.</p>
      <button type="button" className="secondary" data-size="sm" onClick={() => onOpenSettings('Privacy & offline')}>Open Settings</button>
    </div>;
  } else if (!enabled) {
    body = <div className="empty-state research-empty">
      <Globe size={20} aria-hidden="true" />
      <h3>Research browser is off for this case</h3>
      <p>Browse your legal research account beside the chat.</p>
      {loadError ? <p className="small danger-text" role="alert">{loadError}</p> : null}
      <button type="button" className="primary" data-size="sm" disabled={busy} onClick={() => void turnOn()}><Power size={14} aria-hidden="true" />Turn on for this case</button>
    </div>;
  } else {
    body = <div ref={attachSlot} className="research-slot" role="region" aria-label="Research browser" aria-busy={phase === 'opening' || undefined}>
      {phase !== 'open' ? <div className="research-slot-state">
        {phase === 'opening' ? <p className="field-hint" role="status">Opening the research browser…</p> : <>
          <p className="field-hint">The research browser is closed.</p>
          {openError ? <p className="small danger-text" role="alert">{openError}</p> : null}
          <button type="button" className="secondary" data-size="sm" disabled={busy} onClick={() => void open()}><RefreshCw size={14} aria-hidden="true" />Open</button>
        </>}
      </div> : null}
    </div>;
  }

  return <section className="research-pane" aria-label="Research">
    <div className="research-toolbar">
      {native && enabled && !isOffline && phase === 'open' ? <div className="research-toolbar-actions" role="group" aria-label="Page history">
        <button type="button" className="quiet" data-size="sm" aria-label="Back" title="Back" onClick={() => history('back')}><ArrowLeft size={14} aria-hidden="true" /></button>
        <button type="button" className="quiet" data-size="sm" aria-label="Forward" title="Forward" onClick={() => history('forward')}><ArrowRight size={14} aria-hidden="true" /></button>
        <button type="button" className="quiet" data-size="sm" aria-label="Reload" title="Reload" onClick={() => history('reload')}><RotateCw size={14} aria-hidden="true" /></button>
      </div> : null}
      <div className="research-address" role="group" aria-label="Current site">
        {secure ? <Lock size={13} className="research-lock" aria-label="Secure connection" role="img" /> : <Globe size={13} aria-hidden="true" />}
        <input className="research-address-input" readOnly tabIndex={-1} aria-label="Address" value={host ?? ''} placeholder={phase === 'open' ? 'Loading…' : 'Not open'} />
      </div>
      <span className={`research-status research-status-${phase}`} role="status"><span className="research-status-dot" aria-hidden="true" />{statusLabel}</span>
      {native && enabled && !isOffline ? <div className="research-toolbar-actions">
        {phase === 'open' ? <button type="button" className="quiet" data-size="sm" aria-disabled={stopping || undefined} title="Stop the agent's work in this page" onClick={() => void stop()}><Square size={12} aria-hidden="true" />Stop</button> : null}
        {phase === 'open' ? <button type="button" className="quiet" data-size="sm" disabled={busy} onClick={() => void close()}><X size={14} aria-hidden="true" />Close</button> : null}
        <button type="button" className="quiet" data-size="sm" disabled={busy} onClick={() => void signOut()}><LogOut size={14} aria-hidden="true" />Sign out</button>
      </div> : null}
    </div>
    {body}
  </section>;
}
