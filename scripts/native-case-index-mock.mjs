// Synthetic Responses-API provider for measuring the bounded case-index pipeline
// on a real case copy. It follows each unit's protocol mechanically and never
// evaluates evidence: findings it publishes are placeholders citing real refs.
// It records what the app sends (bytes, images, tools) so call counts and
// request sizes can be measured without spending a real model subscription.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const requests = [], errors = [];
const tool = (name, args) => ({ type: 'function_call', call_id: randomUUID(), name, arguments: JSON.stringify(args) });
const text = input => JSON.stringify(input ?? []);
// Tokens are estimated, not measured: ~4 characters per text token and 1,105
// tokens per 1920x1080 high-detail image (OpenAI tiling). Image bytes are excluded.
export function measure(body) {
  let images = 0, textChars = 0;
  for (const item of body.input ?? []) {
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'input_image') images++;
        else textChars += JSON.stringify(part).length;
      }
    } else textChars += JSON.stringify(item).length;
  }
  const instructions = (body.instructions ?? '').length, tools = JSON.stringify(body.tools ?? []).length;
  return { images, text_chars: textChars, instructions_chars: instructions, tools_chars: tools, tools: (body.tools ?? []).length,
    estimated_input_tokens: Math.round((textChars + instructions + tools) / 4) + images * 1105 };
}
function hostRead(input) {
  for (const item of input) {
    const content = typeof item.content === 'string' ? item.content : '';
    const match = content.match(/^Host-performed read_analysis_unit \(receipt ([0-9a-f-]{36});[^\n]*\n([\s\S]*)$/);
    if (match) return { receipt: match[1], unit: JSON.parse(match[2]) };
  }
  return null;
}
const outputs = input => input.filter(x => x.type === 'function_call_output').map(x => { try { return JSON.parse(x.output); } catch { return {}; } });
function firstRef(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.ref_id === 'string' && value.ref_id.startsWith('ref:')) return value.ref_id;
  for (const child of Object.values(value)) { const found = firstRef(child); if (found) return found; }
  return null;
}
const finding = (ref, kind = 'observation') => ({ kind, title: 'Synthetic placeholder finding', text: 'Synthetic protocol placeholder; not an evidence assessment.', supporting: [ref], contrary: [], assessment: 'unresolved', data_json: '{}', support: { state: 'unresolved', reason: 'Synthetic fixture; no evidence was assessed.' } });
export function next(body) {
  const input = body.input ?? [];
  const all = text(input);
  const unitMatch = all.match(/VisLex internal analysis unit ([0-9a-f]{64}) \((\w+)\)/);
  // Chat-completions routes (Z.ai) cannot force a tool; a lone visual tool marks the review.
  const visual = body.tool_choice?.name === 'record_visual_observations' || (body.tools?.length === 1 && body.tools[0].name === 'record_visual_observations');
  if (visual) {
    const observations = [];
    for (const item of input) for (const part of item.content ?? []) {
      if (part.type !== 'input_text') continue;
      const source = part.text.match(/Source ID: ([0-9a-f-]{36})/)?.[1];
      const artifact = part.text.match(/Artifact ID: "([0-9a-f-]{36})"/)?.[1] ?? null;
      if (source) observations.push({ source_id: source, artifact_id: artifact, description: 'Synthetic placeholder observation.', visible_text: '', uncertainty: 'Synthetic fixture; image not examined.' });
    }
    return { kind: 'visual', call: tool('record_visual_observations', { observations }) };
  }
  if (!unitMatch) throw new Error('Request outside an internal analysis unit');
  const kind = unitMatch[2];
  const read = hostRead(input);
  if (!read) throw new Error(`No host read receipt for ${kind}`);
  const done = outputs(input);
  const last = done.at(-1);
  if (last?.error) throw new Error(`Host tool failed for ${kind}: ${JSON.stringify(last).slice(0, 600)}`);
  const receipts = [read.receipt, ...done.map(o => o.receipt_id).filter(Boolean)];
  if (['synthesis_group', 'source_synthesis', 'synthesis'].includes(kind)) {
    if (!last) return { kind, call: tool('query_case_knowledge', { query: '', offset: 0, limit: 200 }) };
    if (last.next_offset != null) return { kind, call: tool('query_case_knowledge', { query: '', offset: last.next_offset, limit: 200 }) };
    const ref = done.map(o => o.items?.[0]?.evidence?.[0]?.ref_id).find(Boolean);
    return { kind, call: tool('publish_analysis_unit', { receipts, findings: ref ? [finding(ref, 'claim')] : [] }) };
  }
  const required = read.unit.required_inspection;
  if (required && !required.included && !last) return { kind, call: tool(required.tool, required.arguments) };
  const ref = firstRef(last?.observations ? done : read.unit.input ?? read.unit) ?? firstRef(read.unit);
  return { kind, call: tool('publish_analysis_unit', { receipts, findings: ref ? [finding(ref)] : [] }) };
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) http.createServer((request, response) => {
  if (request.url === '/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ requests, errors })); return; }
  if (request.url !== '/v1/responses' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
  let raw = ''; request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const size = measure(body);
      const { kind, call } = next(body);
      requests.push({ at: Date.now(), kind, tool: call.name, ...size });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: size.estimated_input_tokens, output_tokens: 200 }, output: [call] } })}\n\n`);
    } catch (error) {
      errors.push(String(error).slice(0, 800));
      response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: String(error) }));
    }
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
