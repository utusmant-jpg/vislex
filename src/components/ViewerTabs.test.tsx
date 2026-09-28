// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ViewerTabs, nextTabIndex, tabPanelProps } from './ViewerTabs';

afterEach(cleanup);

it('maps tablist keys to the next tab index with wrap-around', () => {
  expect(nextTabIndex('ArrowRight', 0, 3)).toBe(1);
  expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
  expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
  expect(nextTabIndex('Home', 2, 3)).toBe(0);
  expect(nextTabIndex('End', 0, 3)).toBe(2);
  expect(nextTabIndex('Enter', 0, 3)).toBe(-1);
  expect(nextTabIndex('ArrowRight', 0, 0)).toBe(-1);
});

function Harness() {
  const [value, setValue] = useState<'one' | 'two' | 'three'>('one');
  const tabs = [{ id: 'one' as const, label: 'One' }, { id: 'two' as const, label: 'Two' }, { id: 'three' as const, label: 'Three' }];
  return <>
    <ViewerTabs tabs={tabs} value={value} onChange={setValue} label="Example views" prefix="example" />
    {tabs.map(tab => <div key={tab.id} {...tabPanelProps('example', tab.id, value === tab.id)}>{tab.label} panel</div>)}
  </>;
}

it('uses roving tabindex, automatic activation and linked tab panels', () => {
  render(<Harness />);
  const list = screen.getByRole('tablist', { name: 'Example views' });
  const one = screen.getByRole('tab', { name: 'One' });
  expect(one.getAttribute('aria-selected')).toBe('true');
  expect(one.tabIndex).toBe(0);
  expect(screen.getByRole('tab', { name: 'Two' }).tabIndex).toBe(-1);
  expect(screen.getByRole('tabpanel', { name: 'One' }).textContent).toBe('One panel');
  one.focus();
  fireEvent.keyDown(list, { key: 'ArrowRight' });
  const two = screen.getByRole('tab', { name: 'Two' });
  expect(two.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(two);
  expect(screen.getByRole('tabpanel', { name: 'Two' }).textContent).toBe('Two panel');
  expect(screen.queryByRole('tabpanel', { name: 'One' })).toBeNull();
  fireEvent.keyDown(list, { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Three' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(list, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'One' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Three' }));
  expect(screen.getByRole('tab', { name: 'Three' }).getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
});
