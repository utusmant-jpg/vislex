// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ContextMenu, ThemeProvider, ToastStack, Tooltip, notify, useTheme } from './ui';
import PaneDivider from './components/PaneDivider';
import SidebarDivider from './components/SidebarDivider';

function AppearanceProbe() {
  const { theme, resolvedTheme, setTheme, density, setDensity } = useTheme();
  return <>
    <output data-testid="appearance">{theme}:{resolvedTheme}:{density}</output>
    <button onClick={() => setTheme('light')}>Light</button>
    <button onClick={() => setTheme('system')}>System</button>
    <button onClick={() => setDensity('compact')}>Compact</button>
  </>;
}

beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.density; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('preserves explicit theme choice and compact density without case data', () => {
  render(<ThemeProvider><AppearanceProbe /></ThemeProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Light' }));
  fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
  expect(screen.getByTestId('appearance').textContent).toBe('light:light:compact');
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(document.documentElement.dataset.density).toBe('compact');
  expect(localStorage.getItem('vislex-theme')).toBe('light');
  expect(localStorage.getItem('vislex-density')).toBe('compact');
});

it('follows operating-system appearance only when System is selected', () => {
  let dark = false;
  let onChange: (() => void) | undefined;
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return dark; },
    addEventListener: (_: string, handler: () => void) => { onChange = handler; },
    removeEventListener: () => {},
  }));
  render(<ThemeProvider><AppearanceProbe /></ThemeProvider>);
  expect(document.documentElement.dataset.theme).toBe('light');
  dark = true;
  act(() => { onChange?.(); });
  expect(document.documentElement.dataset.theme).toBe('dark');
  fireEvent.click(screen.getByRole('button', { name: 'Light' }));
  dark = false;
  act(() => { onChange?.(); });
  expect(document.documentElement.dataset.theme).toBe('light');
  fireEvent.click(screen.getByRole('button', { name: 'System' }));
  expect(localStorage.getItem('vislex-theme')).toBe('system');
});

it('resizes the evidence pane from the keyboard and resets its size', () => {
  const changed = vi.fn();
  const { container, rerender } = render(<div><PaneDivider viewerWidth={520} onWidthChange={changed} /></div>);
  vi.spyOn(container.firstElementChild!, 'getBoundingClientRect').mockReturnValue({ width: 1400 } as DOMRect);
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize evidence pane' }), { key: 'ArrowLeft' });
  expect(changed).toHaveBeenCalledWith(536);
  rerender(<div><PaneDivider viewerWidth={600} onWidthChange={changed} /></div>);
  fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize evidence pane' }));
  expect(changed).toHaveBeenLastCalledWith(520);
});

it('bounds sidebar resizing and restores its default width', () => {
  const changed = vi.fn();
  const { rerender } = render(<SidebarDivider width={310} onWidthChange={changed} />);
  const divider = screen.getByRole('separator', { name: 'Resize navigation sidebar' });
  fireEvent.keyDown(divider, { key: 'ArrowRight', shiftKey: true });
  expect(changed).toHaveBeenLastCalledWith(320);
  rerender(<SidebarDivider width={320} onWidthChange={changed} />);
  fireEvent.doubleClick(divider);
  expect(changed).toHaveBeenLastCalledWith(248);
});

it('keeps one actionable notification for a repeatedly polled error', () => {
  render(<ToastStack />);
  act(() => { notify.error('Synthetic refresh issue', 'Same read failure'); notify.error('Synthetic refresh issue', 'Same read failure'); });
  expect(screen.getAllByText('Synthetic refresh issue')).toHaveLength(1);
});

it('shows a keyboard tooltip with an accessible description and dismisses it on Escape', () => {
  render(<Tooltip text="Open settings" shortcut="Ctrl+,"><button>Settings</button></Tooltip>);
  const trigger = screen.getByRole('button', { name: 'Settings' });
  fireEvent.focus(trigger);
  const tip = screen.getByRole('tooltip');
  expect(tip.textContent).toContain('Open settings');
  expect(trigger.getAttribute('aria-describedby')).toBe(tip.id);
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(trigger.hasAttribute('aria-describedby')).toBe(false);
});

it('opens a context menu from the keyboard and restores focus on Escape', () => {
  render(<ContextMenu items={[{ label: 'Open evidence', onSelect: vi.fn() }]}><button>Evidence row</button></ContextMenu>);
  const trigger = screen.getByRole('button', { name: 'Evidence row' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'F10', shiftKey: true });
  const menu = screen.getByRole('menu', { name: 'Actions' });
  expect(screen.getByRole('menuitem', { name: 'Open evidence' })).toBeTruthy();
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
