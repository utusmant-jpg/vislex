import { useEffect, useRef, useState } from 'react';
import { Info, Keyboard, Palette, X } from 'lucide-react';
import AppearanceSettings from './AppearanceSettings';
import KeyboardSettings from './KeyboardSettings';

const sections = [
  { id: 'Appearance', icon: Palette },
  { id: 'Keyboard & accessibility', icon: Keyboard },
  { id: 'About', icon: Info },
] as const;
type Section = typeof sections[number]['id'];

/** Case-independent preferences (no AI settings). Shares the settings sheet
 *  layout and names with SettingsDialog. */
export default function WorkspacePreferences({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<Section>('Appearance');
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="modal settings-sheet" aria-label="Workspace settings" onCancel={onClose}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        <div className="settings-nav-group">
          {sections.map(({ id, icon: Icon }) => <button key={id} type="button" className={`settings-nav-item ${section === id ? 'selected' : ''}`} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
            {section === id ? <span className="settings-nav-pill" aria-hidden="true" /> : null}
            <span className="settings-nav-icon" aria-hidden="true"><Icon size={15} /></span>
            <span className="settings-nav-label">{id}</span>
          </button>)}
        </div>
        <div className="spacer" />
        <button type="button" className="quiet settings-nav-close" onClick={onClose}>Close</button>
      </nav>
      <div className="settings-body">
        <header className="settings-heading"><div className="settings-heading-text"><h2>{section}</h2></div><button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><X size={18} /></button></header>
        <div className="settings-scroll">
          {section === 'Appearance' ? <AppearanceSettings /> : null}
          {section === 'Keyboard & accessibility' ? <KeyboardSettings /> : null}
          {section === 'About' ? <div className="settings-section settings-about">
            <p><strong>VisLex</strong> · local evidence workspace</p>
            <p className="small muted">Cases are stored in local .ledcase folders. Open a case to configure its AI providers and permissions.</p>
          </div> : null}
        </div>
      </div>
    </div>
  </dialog>;
}
