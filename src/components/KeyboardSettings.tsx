import { useEffect, useState } from 'react';
import { Contrast, Focus, Move } from 'lucide-react';

/** Shortcuts VisLex actually handles (App global handler, lists, menus). */
export const shortcutGroups: { label: string; rows: { keys: string[][]; action: string; joiner?: 'to' | 'or' }[] }[] = [
  { label: 'Workspace', rows: [
    { keys: [['Ctrl', 'K']], action: 'Command palette and case search' },
    { keys: [['Ctrl', ',']], action: 'Open settings' },
    { keys: [['Ctrl', '1'], ['Ctrl', '5']], joiner: 'to', action: 'Chat, Evidence, Findings, Investigate, Jobs' },
    { keys: [['Ctrl', 'B']], action: 'Show or hide navigation' },
    { keys: [['Ctrl', 'N']], action: 'New chat (with a case open)' },
  ] },
  { label: 'Evidence', rows: [
    { keys: [['Ctrl', 'W']], action: 'Close the open evidence tab' },
    { keys: [['Delete']], action: 'Close the focused open-file tab' },
    { keys: [['Alt', '←'], ['Alt', '→']], action: 'Previous or next location' },
    { keys: [['F2']], action: 'Rename the focused item' },
  ] },
  { label: 'Lists, menus and tabs', rows: [
    { keys: [['Shift', 'F10']], action: 'Open the context menu for the focused row' },
    { keys: [['←'], ['→']], action: 'Move between tabs; Home and End jump to the first or last' },
    { keys: [['Esc']], action: 'Close a menu, popover or dialog' },
  ] },
];

function useReducedMotionPreference() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const changed = () => setReduced(media.matches);
    changed();
    media.addEventListener?.('change', changed);
    return () => media.removeEventListener?.('change', changed);
  }, []);
  return reduced;
}

export default function KeyboardSettings() {
  const reduced = useReducedMotionPreference();
  return <div className="settings-section keyboard-settings">
    <section className="settings-card" aria-labelledby="settings-shortcuts-title">
      <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-shortcuts-title">Keyboard shortcuts</h3><p>Every action is also reachable with Tab and Enter. The command palette lists commands by name.</p></div></div>
      {shortcutGroups.map(group => <table className="shortcut-table" key={group.label}>
        <caption>{group.label}</caption>
        <tbody>{group.rows.map(row => <tr key={row.action}>
          <th scope="row">{row.action}</th>
          <td>{row.keys.map((combo, index) => <span className="shortcut-combo" key={combo.join('+')}>{index ? <span className="shortcut-sep">{row.joiner ?? 'or'}</span> : null}{combo.map(key => <kbd key={key}>{key}</kbd>)}</span>)}</td>
        </tr>)}</tbody>
      </table>)}
    </section>
    <section className="settings-card" aria-labelledby="settings-motion-title">
      <div className="settings-card-header"><div className="settings-card-heading"><h3 id="settings-motion-title">Motion, focus and contrast</h3></div></div>
      <ul className="settings-a11y-list">
        <li><Move size={16} aria-hidden="true" /><div><strong>Reduced motion {reduced ? 'is on' : 'is off'}</strong><p>VisLex follows the Windows Animation effects setting (Settings › Accessibility › Visual effects). With animation effects turned off, transitions and indicators change instantly. Original evidence is never animated.</p></div></li>
        <li><Focus size={16} aria-hidden="true" /><div><strong>Visible focus</strong><p>The focused control always shows a ring. Status is shown with an icon and a label, never by colour alone.</p></div></li>
        <li><Contrast size={16} aria-hidden="true" /><div><strong>Contrast themes</strong><p>Windows contrast themes replace VisLex colours; selection and primary controls keep a visible outline.</p></div></li>
      </ul>
    </section>
  </div>;
}
