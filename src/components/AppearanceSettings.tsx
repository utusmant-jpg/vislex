import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../ui';

const themes = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

/** A miniature workspace drawn with the theme's own tokens (scoped by
 *  data-theme), so each choice previews itself regardless of the current one. */
function ThemeSwatch({ theme }: { theme: 'dark' | 'light' }) {
  return <span className="theme-swatch" data-theme={theme} aria-hidden="true">
    <span className="theme-swatch-rail" />
    <span className="theme-swatch-body"><span className="theme-swatch-bar" /><span className="theme-swatch-line" /><span className="theme-swatch-card"><b /><i /></span></span>
  </span>;
}

export default function AppearanceSettings() {
  const { theme, setTheme, resolvedTheme, density, setDensity } = useTheme();
  return <div className="settings-section appearance-settings">
    <p className="small muted">Choose how the workspace reads. System follows your Windows appearance; evidence media keeps its original colors.</p>
    <fieldset className="appearance-group"><legend>Theme</legend>
      <div className="theme-options" role="group" aria-label="Theme">
        {themes.map(({ value, label, icon: Icon }) => <button type="button" key={value} className={`theme-option ${theme === value ? 'selected' : ''}`} aria-pressed={theme === value} onClick={() => setTheme(value)}>
          {value === 'system' ? <span className="theme-swatch-split" aria-hidden="true"><ThemeSwatch theme="dark" /><ThemeSwatch theme="light" /></span> : <ThemeSwatch theme={value} />}
          <span className="theme-option-label"><Icon size={14} aria-hidden="true" />{label}</span>
        </button>)}
      </div>
    </fieldset>
    <fieldset className="appearance-group"><legend>Workspace density</legend>
      <div className="segmented" role="group" aria-label="Workspace density">
        {(['comfortable', 'compact'] as const).map(value => <button type="button" key={value} className={density === value ? 'selected' : ''} aria-pressed={density === value} onClick={() => setDensity(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      <p className="field-hint">Compact tightens rows, controls and padding; text stays at a readable size.</p>
    </fieldset>
    <div className="appearance-preview-heading"><span className="eyebrow">LIVE PREVIEW</span><span className="small muted">{resolvedTheme === 'dark' ? 'Dark' : 'Light'} · {density}</span></div>
    <div className="appearance-preview" data-density={density} aria-hidden="true">
      <div className="appearance-preview-title"><span className="brand-mark"><span/><span/><span/></span><strong>VisLex</strong><span>Case workspace</span></div>
      <div className="appearance-preview-layout">
        <div className="appearance-preview-nav"><span className="selected"/><span/><span/></div>
        <div className="appearance-preview-content"><div className="appearance-preview-bar"/><div className="appearance-preview-line"/><div className="appearance-preview-card"><b/><span/><span/></div><div className="appearance-preview-line short"/></div>
      </div>
    </div>
  </div>;
}
