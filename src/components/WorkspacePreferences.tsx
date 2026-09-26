import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTheme } from '../ui';

export default function WorkspacePreferences({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<'Appearance' | 'About'>('Appearance');
  const { theme, setTheme, density, setDensity } = useTheme();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="modal settings-sheet" aria-label="Workspace settings" onCancel={onClose}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="eyebrow">SETTINGS</div>
        <button className={section === 'Appearance' ? 'selected' : ''} onClick={() => setSection('Appearance')}>Appearance</button>
        <button className={section === 'About' ? 'selected' : ''} onClick={() => setSection('About')}>About</button>
        <div className="spacer" />
        <button className="quiet" onClick={onClose}>Close</button>
      </nav>
      <div className="settings-body">
        <div className="settings-heading"><h2>{section}</h2><button className="icon-button" aria-label="Close settings" onClick={onClose}><X size={18} /></button></div>
        {section === 'Appearance' ? <div className="settings-section">
          <fieldset className="field-label"><legend>Theme</legend><div className="chip-row">
            {(['dark', 'light', 'system'] as const).map(value => <button key={value} className={`chip ${theme === value ? 'selected' : ''}`} onClick={() => setTheme(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
          </div></fieldset>
          <fieldset className="field-label"><legend>Workspace density</legend><div className="chip-row">
            {(['comfortable', 'compact'] as const).map(value => <button key={value} className={`chip ${density === value ? 'selected' : ''}`} onClick={() => setDensity(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
          </div></fieldset>
          <p className="small muted">Appearance is stored on this device. Original evidence images, PDF pages, and video keep their original colors.</p>
        </div> : <div className="settings-section">
          <p><strong>VisLex</strong> · local evidence workspace</p>
          <p className="small muted">Cases are stored in local .ledcase folders. Open a case to configure its AI providers and permissions.</p>
        </div>}
      </div>
    </div>
  </dialog>;
}
