// Synthetic Responses-API provider for the native research journey (R44). It plays the model:
// each reply is chosen from the research tool results the app sent back, so the real agent
// loop, tool checks, out-of-lock browser execution and receipts are exercised end to end.
// Loopback only; synthetic content only.
import http from 'node:http';

const port = Number(process.argv[2] ?? 9363);
const fixture = process.argv[3] ?? 'http://127.0.0.1:9471';
// 'agent' (R44, default) or 'journey' (R51: sign-in refusal, then research through finish_task).
const mode = process.argv[4] ?? 'agent';
const transcript = [];
// Research results seen so far, in order. The app compacts its input after a checkpoint, so the
// synthetic model remembers earlier results itself (one journey per process).
const seen = new Map();

const call = (name, args) => ({ type: 'function_call', call_id: `call-${transcript.length}-${name}`, name, arguments: JSON.stringify(args) });
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

function nextStep(input) {
  const calls = new Map(input.filter(item => item.type === 'function_call').map(item => [item.call_id, item]));
  for (const item of input) {
    if (item.type === 'function_call_output' && calls.get(item.call_id)?.name?.startsWith('research_') && !seen.has(item.call_id)) {
      seen.set(item.call_id, { name: calls.get(item.call_id).name, args: JSON.parse(calls.get(item.call_id).arguments || '{}'), output: String(item.output) });
    }
  }
  const results = [...seen.values()];
  const last = results.at(-1);
  if (!last) return call('research_navigate', { url: `${fixture}/index.html` });
  if (/error|refused|not allowed|may not/i.test(last.output) && !last.output.includes('"snapshot"') && !last.output.includes('"lines"')) {
    return message(`Synthetic research stopped: ${last.name} failed: ${last.output.slice(0, 300)}`);
  }
  const navigate = results.find(result => result.name === 'research_navigate');
  const ref = pattern => navigate?.output.match(pattern)?.[1];
  const version = Number(navigate?.output.match(/\\?"version\\?"\s*:\s*(\d+)/)?.[1]);
  // R46: open the synthetic opinion, read it, and capture the lines holding the opinion's words.
  const opinion = `${fixture}/opinion.html`;
  if (last.name === 'research_navigate' && last.args.url === opinion) return call('research_read_page', { offset: 0, count: 50 });
  if (last.name === 'research_navigate') {
    return call('research_act', { action: 'type', ref: ref(/searchbox \\?"Search\\?" \[ref=(e\d+)\]/), snapshot_version: version, text: 'duty of care /s negligence', key: null });
  }
  if (last.name === 'research_act' && last.args.action === 'type') {
    return call('research_act', { action: 'click', ref: ref(/button \\?"Search\\?" \[ref=(e\d+)\]/), snapshot_version: version, text: null, key: null });
  }
  if (last.name === 'research_act') return call('research_read_page', { offset: 0, count: 20 });
  if (last.name === 'research_read_page' && !results.some(result => result.name === 'research_navigate' && result.args.url === opinion)) {
    return call('research_navigate', { url: opinion });
  }
  if (last.name === 'research_read_page') {
    const lines = parse(last.output)?.lines ?? [];
    const start = lines.find(line => line.text.includes('duty of reasonable care'));
    const end = lines.find(line => line.text.includes('foreseeable risk of harm'));
    if (!start || !end) return message(`Synthetic research stopped: the opinion lines were not found in ${last.output.slice(0, 300)}`);
    return call('research_capture', {
      title: 'Smith v. Synthetic Holdings',
      jurisdiction: '9th Cir.',
      relevant_date: null,
      citation_text: '123 F.3d 456',
      proposition: 'A duty of reasonable care is owed to foreseeable plaintiffs.',
      quote_start_line: start.n,
      quote_end_line: end.n,
    });
  }
  const firstRead = results.find(result => result.name === 'research_read_page');
  const firstLine = firstRead?.output.match(/\\?"text\\?"\s*:\s*\\?"([^"\\]+)/)?.[1] ?? 'nothing';
  const locator = parse(last.output)?.locator ?? 'none';
  return message(`Synthetic research answer: the page begins "${firstLine}". Captured authority at ${locator}.`);
}

// ---------------------------------------------------------------- R51 journey mode
// Two tasks, told apart by a marker in the user's prompt. JOURNEY-SIGNIN: check the page, look
// at it, try to type into its search box (the app refuses while a password field is on the
// page), then stop and ask the user. JOURNEY-RESEARCH: search, read, open the opinion, read it,
// capture the quoted lines, declare a one-claim dossier citing the capture's locator, and finish
// through finish_task (which asks for a support review first, as agent.rs requires).
const journeySeen = { signin: new Map(), research: new Map() };
const SIGNIN_STOP = 'Synthetic journey: a sign-in page is showing in the research browser, so I stopped. Please sign in, or return to the research site, in the Browser view.';

function userText(item) {
  if (item.role !== 'user') return '';
  if (typeof item.content === 'string') return item.content;
  return (item.content ?? []).map(part => part.text ?? '').join(' ');
}

function journeyPhase(input) {
  const marked = input.map(userText).filter(text => text.includes('JOURNEY-'));
  const last = marked.at(-1) ?? '';
  return last.includes('JOURNEY-SIGNIN') ? 'signin' : last.includes('JOURNEY-RESEARCH') ? 'research' : null;
}

function remember(input, memory) {
  const calls = new Map(input.filter(item => item.type === 'function_call').map(item => [item.call_id, item]));
  for (const item of input) {
    const request = calls.get(item.call_id);
    if (item.type === 'function_call_output' && request && request.name !== 'checkpoint_review' && !memory.has(item.call_id)) {
      memory.set(item.call_id, { name: request.name, args: JSON.parse(request.arguments || '{}'), output: String(item.output) });
    }
  }
  return [...memory.values()];
}

const refOf = (output, pattern) => output.match(pattern)?.[1];
const versionOf = output => Number(output.match(/\\?"version\\?"\s*:\s*(\d+)/)?.[1]);

function signinStep(results) {
  const last = results.at(-1);
  if (!last) return call('research_status', {});
  if (last.name === 'research_status') return call('research_snapshot', { scope: 'interactive', find: null, delta: false, max_chars: null });
  if (last.name === 'research_snapshot') {
    const ref = refOf(last.output, /searchbox \\?"Search\\?" \[ref=(e\d+)\]/);
    if (!ref) return message(`${SIGNIN_STOP} (No search box: ${last.output.slice(0, 200)})`);
    return call('research_act', { action: 'type', ref, snapshot_version: versionOf(last.output), text: 'duty of care /s negligence', key: null });
  }
  return message(`${SIGNIN_STOP} The browser reported: ${last.output.slice(0, 240)}`);
}

function researchJourneyStep(results) {
  const last = results.at(-1);
  const index = `${fixture}/index.html`;
  const opinion = `${fixture}/opinion.html`;
  if (!last) return call('research_navigate', { url: index });
  // agent.rs returns a failed tool as {"error": "..."}.
  if (parse(last.output)?.error !== undefined) return message(`Synthetic research stopped: ${last.name} failed: ${last.output.slice(0, 300)}`);
  const navigateIndex = results.find(result => result.name === 'research_navigate' && result.args.url === index);
  const capture = results.find(result => result.name === 'research_capture');
  const locator = capture ? parse(capture.output)?.locator : undefined;
  const answer = locator ? {
    answer: `Synthetic research answer: Smith v. Synthetic Holdings, 123 F.3d 456, holds that a person owes a duty of reasonable care to foreseeable plaintiffs ${locator}.`,
    blocks: null,
    citations: [locator],
    gaps: ['Synthetic journey: citator status was not checked in the fixture.'],
  } : null;
  switch (last.name) {
    case 'research_navigate':
      if (last.args.url === opinion) return call('research_read_page', { offset: 0, count: 50 });
      return call('research_act', { action: 'type', ref: refOf(last.output, /searchbox \\?"Search\\?" \[ref=(e\d+)\]/), snapshot_version: versionOf(last.output), text: 'duty of care /s negligence', key: null });
    case 'research_act':
      if (last.args.action === 'type') return call('research_act', { action: 'click', ref: refOf(navigateIndex?.output ?? '', /button \\?"Search\\?" \[ref=(e\d+)\]/), snapshot_version: versionOf(navigateIndex?.output ?? ''), text: null, key: null });
      return call('research_read_page', { offset: 0, count: 20 });
    case 'research_read_page': {
      if (!results.some(result => result.name === 'research_navigate' && result.args.url === opinion)) return call('research_navigate', { url: opinion });
      const lines = parse(last.output)?.lines ?? [];
      const start = lines.find(line => line.text.includes('duty of reasonable care'));
      const end = lines.find(line => line.text.includes('foreseeable risk of harm'));
      if (!start || !end) return message(`Synthetic research stopped: the opinion lines were not found in ${last.output.slice(0, 300)}`);
      return call('research_capture', {
        title: 'Smith v. Synthetic Holdings', jurisdiction: '9th Cir.', relevant_date: null, citation_text: '123 F.3d 456',
        proposition: 'A duty of reasonable care is owed to foreseeable plaintiffs.', quote_start_line: start.n, quote_end_line: end.n,
      });
    }
    case 'research_capture':
      if (!locator) return message(`Synthetic research stopped: the capture returned no locator: ${last.output.slice(0, 300)}`);
      return call('save_dossier', {
        revision: 0,
        scope: 'Synthetic journey: one opinion captured from the loopback research fixture.',
        checks: [],
        claims: [{
          id: 'claim-duty', proposition: 'A duty of reasonable care is owed to foreseeable plaintiffs.', assessment: 'supported_within_scope',
          supporting: [locator], contrary: [], uncertainty: 'One synthetic opinion; citator status not checked.', next_check: 'Check citator treatment.',
        }],
      });
    case 'save_dossier':
      return call('finish_task', answer);
    case 'finish_task': {
      const result = parse(last.output) ?? {};
      if (result.status === 'review_required' && result.candidate) {
        const saved = results.filter(item => item.name === 'save_dossier').at(-1);
        const revision = parse(saved?.output ?? '')?.dossier?.revision ?? 1;
        return call('review_candidate', {
          revision, candidate: result.candidate,
          assessments: [{ claim_index: 0, state: 'supported', reason: 'The captured opinion lines state the duty in these words.' }],
          block_reviews: null,
        });
      }
      if (result.status === 'review_required') return call('finish_task', answer);
      return message(`Synthetic research finished: ${last.output.slice(0, 200)}`);
    }
    case 'review_candidate':
      return call('finish_task', answer);
    default:
      return message(`Synthetic research stopped after ${last.name}: ${last.output.slice(0, 200)}`);
  }
}

function journeyStep(input) {
  const phase = journeyPhase(input);
  if (!phase) return message('Synthetic journey: no journey marker in the prompt.');
  const results = remember(input, journeySeen[phase]);
  return phase === 'signin' ? signinStep(results) : researchJourneyStep(results);
}

// Tool outputs are JSON text; tolerate one extra level of string encoding.
function parse(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

// Journey mode: after the capture, the synthetic model waits (up to two minutes) for POST /release
// before declaring its dossier, so the reviewer's cite-check lands while the task still runs.
let released = false;
let holding = false;
async function heldUntilReleased() {
  holding = true;
  for (let waited = 0; !released && waited < 120_000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  holding = false;
}

http.createServer((request, response) => {
  if (request.url === '/state') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mode, requests: transcript.length, holding, released, transcript }));
    return;
  }
  if (request.url === '/release' && request.method === 'POST') {
    released = true;
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url !== '/v1/responses' || request.method !== 'POST') {
    response.writeHead(404);
    response.end();
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 32 * 1024 * 1024) request.destroy(); });
  request.on('end', async () => {
    const payload = JSON.parse(body);
    const offered = (payload.tools ?? []).map(tool => tool.name);
    // The app periodically requires a progress checkpoint and offers only that tool.
    const checkpoint = payload.tool_choice?.name === 'checkpoint_review'
      ? call('checkpoint_review', { summary: 'Synthetic checkpoint: research in progress on the fixture site.', citations: [], gaps: [], next_steps: ['Continue the research journey.'] })
      : null;
    const next = mode === 'journey' ? journeyStep : nextStep;
    const step = checkpoint ?? (offered.includes('research_navigate') ? next(payload.input ?? []) : message('Synthetic research answer: research tools were not offered.'));
    if (mode === 'journey' && step.name === 'save_dossier') await heldUntilReleased();
    transcript.push({ mode, offered_research: offered.filter(name => name.startsWith('research_')), step: step.name ?? 'message', arguments: step.arguments ?? step.content?.[0]?.text });
    const value = { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [step] };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: value })}\n\n`);
  });
}).listen(port, '127.0.0.1');
