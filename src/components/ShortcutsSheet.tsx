// Ctrl+/ — every shortcut VisLex handles, in one modal sheet.
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { shortcutGroups } from './KeyboardSettings';

export default function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal?.();
    return () => { if (element?.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="modal shortcuts-sheet" aria-label="Keyboard shortcuts" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading">
      <div><h2>Keyboard shortcuts</h2><p>Every action is also reachable with Tab and Enter.</p></div>
      <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={16} /></button>
    </div>
    <div className="shortcuts-grid">
      {shortcutGroups.map(group => <table className="shortcut-table" key={group.label}>
        <caption>{group.label}</caption>
        <tbody>{group.rows.map(row => <tr key={row.action}>
          <th scope="row">{row.action}</th>
          <td>{row.keys.map((combo, index) => <span className="shortcut-combo" key={combo.join('+')}>{index ? <span className="shortcut-sep">{row.joiner ?? 'or'}</span> : null}{combo.map(key => <kbd key={key}>{key}</kbd>)}</span>)}</td>
        </tr>)}</tbody>
      </table>)}
    </div>
  </dialog>;
}
