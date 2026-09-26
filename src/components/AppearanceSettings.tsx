import { useTheme } from '../ui';

export default function AppearanceSettings() {
  const { theme, setTheme, resolvedTheme, density, setDensity } = useTheme();
  return <div className="settings-section appearance-settings">
    <p className="small muted">Choose how the workspace reads. System follows your Windows appearance; evidence media keeps its original colors.</p>
    <fieldset className="field-label"><legend>Theme</legend>
      <div className="chip-row" role="group" aria-label="Theme">
        {(['dark', 'light', 'system'] as const).map(value => <button type="button" key={value} className={`chip ${theme === value ? 'selected' : ''}`} aria-pressed={theme === value} onClick={() => setTheme(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
    </fieldset>
    <fieldset className="field-label"><legend>Workspace density</legend>
      <div className="chip-row" role="group" aria-label="Workspace density">
        {(['comfortable', 'compact'] as const).map(value => <button type="button" key={value} className={`chip ${density === value ? 'selected' : ''}`} aria-pressed={density === value} onClick={() => setDensity(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
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
