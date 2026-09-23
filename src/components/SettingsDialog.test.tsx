// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsDialog from './SettingsDialog';
import type { Snapshot } from '../types';

const api = vi.hoisted(() => vi.fn());
vi.mock('../bridge', () => ({ api, native: true }));

const snapshot: Snapshot = {
  id:'synthetic',name:'Synthetic case',root:'C:\\synthetic',generation:1,sources:[],records:[],tasks:[],budget_committed:0,
  settings:{offline:false,allow_text:true,allow_images:false,model:'gpt-test',case_budget:0,input_per_million:0,output_per_million:0},
};

beforeEach(() => {
  api.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  api.mockImplementation(async (action: string) => {
    if (action === 'ai_access_route') return {route:'api_keys',subscription:null,subscription_ready:false,blocker:'Windows isolation is unverified'};
    if (action === 'codex_account_status') return {connected:true,email:'test@example.invalid',plan:'plus'};
    if (action === 'provider_key_status') return {configured:true};
    if (action === 'direct_media_permission') return {enabled:false};
    if (action === 'codex_account_models') return [
      {id:'model-a',name:'Model A',efforts:['medium','high'],default_effort:'medium'},
      {id:'model-b',name:'Model B',efforts:['low','max'],default_effort:'max'},
    ];
    return null;
  });
});
afterEach(cleanup);

it('keeps subscription execution unavailable while leaving the API route selected', async () => {
  render(<SettingsDialog snapshot={snapshot} onClose={vi.fn()} refresh={async () => undefined} run={fn => {void fn();}} />);
  const choice = await screen.findByRole('button',{name:'ChatGPT subscription'});
  await waitFor(() => expect(choice.hasAttribute('disabled')).toBe(true));
  fireEvent.click(choice);
  expect(api).not.toHaveBeenCalledWith('set_ai_access_route',{route:'chatgpt_subscription'});
  expect(screen.getByText(/Windows isolation is unverified/)).toBeTruthy();
});

it('uses only efforts returned for the selected subscription model', async () => {
  render(<SettingsDialog snapshot={snapshot} onClose={vi.fn()} refresh={async () => undefined} run={fn => {void fn();}} />);
  fireEvent.click(await screen.findByRole('button',{name:'Load subscription models'}));
  const model = await screen.findByRole('combobox',{name:'ChatGPT subscription model'});
  fireEvent.change(model,{target:{value:'model-b'}});
  const effort = screen.getByRole('combobox',{name:'ChatGPT reasoning effort'}) as HTMLSelectElement;
  expect(effort.value).toBe('max');
  expect(Array.from(effort.options).map(option => option.value)).toEqual(['low','max']);
  fireEvent.click(screen.getByRole('button',{name:'Save subscription model'}));
  await waitFor(() => expect(api).toHaveBeenCalledWith('save_codex_selection',{model:'model-b',effort:'max'}));
});

it('starts and cancels a browser login without touching saved API keys', async () => {
  const original=api.getMockImplementation()!;
  api.mockImplementation(async (action:string, args?:unknown) => {
    if (action === 'codex_account_status') return {connected:false};
    if (action === 'codex_account_login') return {login_id:'synthetic-login',auth_url:'https://chatgpt.com/synthetic'};
    return original(action,args);
  });
  render(<SettingsDialog snapshot={snapshot} onClose={vi.fn()} refresh={async () => undefined} run={fn => {void fn();}} />);
  fireEvent.click(await screen.findByRole('button',{name:'Sign in with ChatGPT'}));
  expect((await screen.findByRole('link',{name:'Open ChatGPT sign-in'})).getAttribute('href')).toBe('https://chatgpt.com/synthetic');
  fireEvent.click(screen.getByRole('button',{name:'Cancel sign-in'}));
  await waitFor(() => expect(api).toHaveBeenCalledWith('codex_account_cancel_login',{login_id:'synthetic-login'}));
  expect(api).not.toHaveBeenCalledWith('save_provider_key',expect.anything());
  expect(api).not.toHaveBeenCalledWith('delete_provider_key',expect.anything());
});
