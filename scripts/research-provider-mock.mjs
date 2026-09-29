// Synthetic Responses-API provider for the native research journey (R44). It plays the model:
// each reply is chosen from the research tool results the app sent back, so the real agent
// loop, tool checks, out-of-lock browser execution and receipts are exercised end to end.
// Loopback only; synthetic content only.
import http from 'node:http';

const port = Number(process.argv[2] ?? 9363);
const fixture = process.argv[3] ?? 'http://127.0.0.1:9471';
const transcript = [];

const call = (name, args) => ({ type: 'function_call', call_id: `call-${transcript.length}-${name}`, name, arguments: JSON.stringify(args) });
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

function nextStep(input) {
  const calls = new Map(input.filter(item => item.type === 'function_call').map(item => [item.call_id, item]));
  const results = input.filter(item => item.type === 'function_call_output' && calls.get(item.call_id)?.name?.startsWith('research_'))
    .map(item => ({ name: calls.get(item.call_id).name, args: JSON.parse(calls.get(item.call_id).arguments || '{}'), output: String(item.output) }));
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

// Tool outputs are JSON text; tolerate one extra level of string encoding.
function parse(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

http.createServer((request, response) => {
  if (request.url === '/state') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ requests: transcript.length, transcript }));
    return;
  }
  if (request.url !== '/v1/responses' || request.method !== 'POST') {
    response.writeHead(404);
    response.end();
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; if (body.length > 32 * 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    const payload = JSON.parse(body);
    const offered = (payload.tools ?? []).map(tool => tool.name);
    const step = offered.includes('research_navigate') ? nextStep(payload.input ?? []) : message('Synthetic research answer: research tools were not offered.');
    transcript.push({ offered_research: offered.filter(name => name.startsWith('research_')), step: step.name ?? 'message', arguments: step.arguments ?? step.content?.[0]?.text });
    const value = { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [step] };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: value })}\n\n`);
  });
}).listen(port, '127.0.0.1');
