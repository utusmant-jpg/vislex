// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AgentPanel from './AgentPanel';
import type { Snapshot } from '../types';

const api=vi.hoisted(()=>vi.fn());
vi.mock('../bridge',async importOriginal=>({...(await importOriginal<typeof import('../bridge')>()),api,native:true}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
afterEach(()=>{cleanup();api.mockReset();});

it('continues a paused chat in a fresh task from its saved progress',async()=>{
  const snapshot:Snapshot={
    id:'synthetic-case',name:'Synthetic case',root:'C:\\synthetic',generation:1,sources:[],records:[],budget_committed:0,
    settings:{offline:false,allow_text:true,allow_images:false,model:'synthetic',case_budget:0,input_per_million:0,output_per_million:0},
    tasks:[{id:'old-task',conversation_id:'conversation',prompt:'Review the claim',mode:'investigate',status:'paused',budget:0,reserved:0,spent:0,input_tokens:10,output_tokens:1,step:1,answer:'Saved partial finding',error:'Provider response incomplete',generation:1,created_at:'now'}],
  };
  api.mockResolvedValue({task_id:'new-task',conversation_id:'conversation'});
  const onConversation=vi.fn();const refresh=vi.fn(async()=>{});
  render(<AgentPanel snapshot={snapshot} selection={null} refresh={refresh} run={fn=>{void fn();}} onSource={()=>{}} onSettings={()=>{}} conversationId="conversation" onConversation={onConversation}/>);
  fireEvent.click(screen.getByRole('button',{name:'Continue in new task'}));
  await waitFor(()=>expect(api).toHaveBeenCalledWith('continue_paused_task',{task_id:'old-task'}));
  expect(onConversation).toHaveBeenCalledWith('conversation');
  expect(refresh).toHaveBeenCalled();
});
