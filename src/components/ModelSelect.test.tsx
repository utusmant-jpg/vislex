// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ModelSelect from './ModelSelect';

beforeAll(() => {
  // cmdk scrolls the active option into view; happy-dom has no layout.
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const options = [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'm2' }];
const highlighted = () => document.querySelector('[cmdk-item][data-selected="true"]')?.textContent ?? '(none)';

it('names the trigger with its current value', () => {
  render(<ModelSelect label="Primary model" value="m1" options={options} placeholder="No model" onChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Primary model: m1' })).toBeTruthy();
});

it('keeps a real highlight through the clear row so arrows and Enter always work', () => {
  const onChange = vi.fn();
  render(<ModelSelect label="Primary model" value="m1" options={options} placeholder="No model" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Primary model: m1' }));
  const filter = screen.getByRole('combobox');
  expect(highlighted()).toBe('m1');
  fireEvent.keyDown(filter, { key: 'ArrowUp' });
  expect(highlighted()).toBe('No model');
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  expect(highlighted()).toMatch(/^m1/);
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  expect(highlighted()).toBe('m2');
  fireEvent.keyDown(filter, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('m2');
});

it('clears the saved value from the keyboard', () => {
  const onChange = vi.fn();
  render(<ModelSelect label="Primary model" value="m1" options={options} placeholder="No model" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Primary model: m1' }));
  const filter = screen.getByRole('combobox');
  fireEvent.keyDown(filter, { key: 'ArrowUp' });
  fireEvent.keyDown(filter, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('');
});
