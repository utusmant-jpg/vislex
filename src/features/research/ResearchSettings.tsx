import { useEffect, useRef, useState } from 'react';
import { LogOut, Plus, Trash2 } from 'lucide-react';
import { native } from '../../bridge';
import type { Snapshot } from '../../types';
import { RESEARCH_GRANT_CHANGED, clearResearchSession, errorText, researchGrant, setResearchGrant, type ResearchGrant } from './api';
import './research.css';

/** Settings → Research browser: the per-case switch, extra sign-in hosts, and signing out. */
export default function ResearchSettings({ snapshot }: { snapshot: Snapshot | null }) {
  const caseId = snapshot?.id;
  const sessionEpoch = snapshot?.session_epoch;
  const offline = !!snapshot?.settings.offline;
  const [grant, setGrant] = useState<ResearchGrant | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hostError, setHostError] = useState('');
  const [newHost, setNewHost] = useState('');
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutStatus, setSignOutStatus] = useState('');
  const [signOutError, setSignOutError] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    if (!native || !caseId) { setLoaded(true); return; }
    let active = true;
    researchGrant(caseId, sessionEpoch).then(value => { if (active) { setGrant(value); setLoaded(true); } }).catch(e => { if (active) { setError(errorText(e)); setLoaded(true); } });
    const changed = (event: Event) => { const detail = (event as CustomEvent<{ caseId: string; grant: ResearchGrant }>).detail; if (detail?.caseId === caseId) setGrant(detail.grant); };
    window.addEventListener(RESEARCH_GRANT_CHANGED, changed);
    return () => { active = false; window.removeEventListener(RESEARCH_GRANT_CHANGED, changed); };
  }, [caseId, sessionEpoch]);

  const enabled = !!grant?.enabled;
  const hosts = grant?.sso_hosts ?? [];
  const reason = !native ? 'Available in the Windows desktop app.' : !snapshot ? 'Open a case to change this setting.' : offline ? 'This case is offline. Allow AI dispatch in Privacy & offline to turn the research browser on.' : '';
  const caseReady = native && !!snapshot;
  // Turning off is always allowed for an open case; turning on needs it online.
  const switchDisabled = !caseReady || busy || !loaded || (!enabled && offline);
  const hostsDisabled = !caseReady || busy || !loaded || offline;

  async function update(nextEnabled: boolean, nextHosts: string[] | undefined, onError: (message: string) => void) {
    if (!caseId) return false;
    setBusy(true); setError(''); setHostError('');
    try {
      const next = await setResearchGrant(caseId, sessionEpoch, nextEnabled, nextHosts);
      if (live.current) setGrant(next);
      return true;
    } catch (e) {
      if (live.current) onError(errorText(e));
      return false;
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function addHost() {
    const host = newHost.trim();
    if (!host) { setHostError('Enter a host name such as login.firm.example.'); return; }
    if (await update(enabled, [...hosts, host], setHostError) && live.current) setNewHost('');
  }
  async function signOut() {
    setSignOutBusy(true); setSignOutStatus(''); setSignOutError('');
    try { await clearResearchSession(); if (live.current) setSignOutStatus('Signed out. The research session was cleared from this computer.'); }
    catch (e) { if (live.current) setSignOutError(errorText(e)); }
    finally { if (live.current) setSignOutBusy(false); }
  }

  return <div className="research-settings">
    <section className="settings-card" aria-labelledby="settings-research-title">
      <div className="settings-card-header">
        <div className="settings-card-heading">
          <h3 id="settings-research-title">Research browser for this case</h3>
          <p>Browse your legal research account beside the chat. VisLex can search and read it for this case when it is on.</p>
        </div>
        <button
          type="button"
          role="switch"
          className="research-switch"
          aria-checked={enabled}
          aria-labelledby="settings-research-title"
          aria-describedby={reason ? 'settings-research-reason' : undefined}
          disabled={switchDisabled}
          onClick={() => void update(!enabled, undefined, setError)}
        ><span className="research-switch-thumb" aria-hidden="true" /></button>
      </div>
      <p className="settings-fact" role="status">{!loaded ? 'Loading…' : enabled ? 'On for this case.' : 'Off for this case.'}</p>
      {reason ? <p className="field-hint" id="settings-research-reason">{reason}</p> : null}
      {error ? <p role="alert" className="small danger-text">{error}</p> : null}
    </section>

    <section className="settings-card" aria-labelledby="settings-research-hosts-title">
      <div className="settings-card-header"><div className="settings-card-heading">
        <h3 id="settings-research-hosts-title">Sign-in hosts</h3>
        <p>Add your firm's single sign-on host if your research account signs in through it. Changing this list closes the research browser; open it again to continue.</p>
      </div></div>
      {hosts.length ? <ul className="research-host-list" aria-label="Sign-in hosts">
        {hosts.map(host => <li key={host}>
          <span className="mono">{host}</span>
          <button type="button" className="icon-button" aria-label={`Remove ${host}`} disabled={hostsDisabled} onClick={() => void update(enabled, hosts.filter(item => item !== host), setHostError)}><Trash2 size={15} /></button>
        </li>)}
      </ul> : <p className="settings-empty">No extra sign-in hosts.</p>}
      <form className="research-host-add" onSubmit={event => { event.preventDefault(); void addHost(); }}>
        <input
          aria-label="Sign-in host"
          value={newHost}
          disabled={hostsDisabled}
          spellCheck={false}
          autoComplete="off"
          placeholder="login.firm.example"
          aria-invalid={hostError ? true : undefined}
          aria-describedby={hostError ? 'settings-research-host-error' : undefined}
          onChange={event => { setNewHost(event.target.value); setHostError(''); }}
        />
        <button type="submit" className="secondary" data-size="sm" disabled={hostsDisabled}><Plus size={14} aria-hidden="true" />Add host</button>
      </form>
      {hostError ? <p role="alert" id="settings-research-host-error" className="small danger-text">{hostError}</p> : null}
    </section>

    <section className="settings-card" aria-labelledby="settings-research-session-title">
      <div className="settings-card-header">
        <div className="settings-card-heading">
          <h3 id="settings-research-session-title">Research session</h3>
          <p>Sign-ins made in the research browser are kept on this computer, outside every case folder, and shared by all cases.</p>
        </div>
        <div className="card-actions">
          <button type="button" className="secondary" data-size="sm" disabled={!native || signOutBusy} onClick={() => void signOut()}><LogOut size={14} aria-hidden="true" />{signOutBusy ? 'Signing out…' : 'Sign out and clear research session'}</button>
        </div>
      </div>
      {signOutStatus ? <p className="settings-fact" role="status">{signOutStatus}</p> : null}
      {signOutError ? <p role="alert" className="small danger-text">{signOutError}</p> : null}
    </section>
  </div>;
}
