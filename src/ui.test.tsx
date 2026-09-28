// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Combobox, ModelPicker, Tooltip, modelBadges, overlayHost } from './ui';
import type { Snapshot } from './types';

beforeAll(() => {
  // cmdk scrolls the active option into view; happy-dom has no layout.
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const snapshot = {
  id: 'synthetic', name: 'Synthetic', root: 'C:\\synthetic', generation: 1, sources: [], records: [], tasks: [],
  settings: { offline: false, allow_text: true, allow_images: false, model: 'gpt-synthetic' },
  ai_config: { provider: 'openai', execution: 'single', review: 'standard', pool: [
    { provider: 'anthropic', model: 'claude-synthetic', allow_text: true, allow_images: false },
    { provider: 'openrouter', model: 'vendor/model:free', allow_text: true, allow_images: false },
    { provider: 'gemini', model: 'gemini-not-permitted', allow_text: false, allow_images: false },
  ] },
} as unknown as Snapshot;

it('lists each permitted model exactly once, under its own provider', () => {
  render(<ModelPicker snapshot={snapshot} selected={undefined} onSelect={vi.fn()} onManage={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Model for your next message' }));
  const options = screen.getAllByRole('option');
  expect(options.map(option => option.textContent?.split(/Default|Free/)[0])).toEqual(['gpt-synthetic', 'claude-synthetic', 'vendor/model:free']);
  expect(screen.getAllByRole('listbox')).toHaveLength(1);
  const anthropic = screen.getByRole('group', { name: 'Claude / Anthropic' });
  expect(within(anthropic).getAllByRole('option')).toHaveLength(1);
  expect(screen.queryByText('gemini-not-permitted')).toBeNull();
});

it('selects the highlighted model with Enter from the filter and restores focus on Escape', () => {
  const onSelect = vi.fn();
  render(<ModelPicker snapshot={snapshot} selected={undefined} onSelect={onSelect} onManage={vi.fn()} />);
  const trigger = screen.getByRole('button', { name: 'Model for your next message' });
  trigger.focus();
  fireEvent.click(trigger);
  const filter = screen.getByRole('combobox');
  fireEvent.change(filter, { target: { value: 'claude' } });
  fireEvent.keyDown(filter, { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'claude-synthetic' }));
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('never presents capability guesses as badges', () => {
  expect(modelBadges('gpt-5-vision-reasoning-mini', false)).toEqual([]);
  expect(modelBadges('claude-opus', true)).toEqual(['Default']);
  expect(modelBadges('vendor/model:free', false)).toEqual(['Free variant']);
});

it('renders overlays opened from inside an open modal dialog within that dialog', () => {
  // A modal <dialog> makes the rest of the document inert, so an option list
  // portalled to <body> could not be clicked.
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.append(dialog);
  const onChange = vi.fn();
  render(<Combobox label="Synthetic model" value="" options={[{ value: 'alpha', label: 'Alpha' }]} onChange={onChange} />, { container: dialog.appendChild(document.createElement('div')) });
  fireEvent.click(screen.getByRole('button', { name: 'Synthetic model' }));
  const option = screen.getByRole('option', { name: /Alpha/ });
  expect(dialog.contains(option)).toBe(true);
  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith('alpha');
  expect(overlayHost(dialog.firstElementChild)).toBe(dialog);
  dialog.removeAttribute('open');
  expect(overlayHost(dialog.firstElementChild)).toBe(document.body);
  expect(overlayHost(null)).toBe(document.body);
  dialog.remove();
});

it('keeps overlays outside a dialog on the document body', () => {
  render(<Tooltip text="Synthetic tip"><button>Tip target</button></Tooltip>);
  fireEvent.focus(screen.getByRole('button', { name: 'Tip target' }));
  expect(screen.getByRole('tooltip').parentElement).toBe(document.body);
});
