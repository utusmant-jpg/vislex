import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import AppearanceSettings from './AppearanceSettings';

export default function WorkspacePreferences({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<'Appearance' | 'About'>('Appearance');
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
        {section === 'Appearance' ? <AppearanceSettings /> : <div className="settings-section">
          <p><strong>VisLex</strong> · local evidence workspace</p>
          <p className="small muted">Cases are stored in local .ledcase folders. Open a case to configure its AI providers and permissions.</p>
        </div>}
      </div>
    </div>
  </dialog>;
}
