// Synthetic Z.ai GLM Coding Plan provider (OpenAI Chat Completions protocol)
// for the bounded case-index pipeline. It follows each unit's protocol through
// the same mechanical logic as native-case-index-mock.mjs, never evaluates
// evidence, and checks what VisLex sends to Z.ai: endpoint, key header, max
// reasoning, tool_choice "auto", and that only an image-capable model
// (glm-5.3-flash) ever receives images. Violations are reported as errors.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { measure, next } from './native-case-index-mock.mjs';
const port = Number(process.argv[2]);
const PATH = '/api/coding/paas/v4/chat/completions';
const VISION = new Set(['glm-5.3-flash']);
const requests = [], errors = [];

/** Chat messages back to the Responses-shaped input the shared logic reads. */
function toResponses(body) {
  const input = [];
  let instructions = '';
  for (const message of body.messages ?? []) {
    if (message.role === 'system') { instructions += message.content ?? ''; continue; }
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }); continue; }
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      continue;
    }
    const content = Array.isArray(message.content)
      ? message.content.map(part => part.type === 'image_url' ? { type: 'input_image', image_url: part.image_url.url } : { type: 'input_text', text: part.text })
      : message.content;
    input.push({ type: 'message', role: message.role, content });
  }
  const tools = (body.tools ?? []).map(tool => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
  return { instructions, input, tools };
}

function violations(request, body, images) {
  const found = [];
  if (request.url !== PATH) found.push(`path ${request.url}`);
  if (!/^Bearer \S+/.test(request.headers.authorization ?? '')) found.push('missing bearer key');
  if (!['glm-5.3', 'glm-5.3-flash'].includes(body.model)) found.push(`model ${body.model}`);
  if (body.thinking?.type !== 'enabled') found.push('thinking not enabled');
  if (body.reasoning_effort !== 'max') found.push(`reasoning_effort ${body.reasoning_effort}`);
  if (body.tools && body.tool_choice !== 'auto') found.push(`tool_choice ${JSON.stringify(body.tool_choice)}`);
  if (body.stream !== true) found.push('not streaming');
  if ('provider' in body || 'reasoning' in body) found.push('OpenRouter/OpenAI-only field sent');
  if (images && !VISION.has(body.model)) found.push(`${images} image(s) sent to text-only ${body.model}`);
  return found;
}

const chunk = value => `data: ${JSON.stringify(value)}\n\n`;
http.createServer((request, response) => {
  if (request.url === '/state') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ requests, errors })); return; }
  if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
  let raw = ''; request.on('data', part => { raw += part; });
  request.on('end', () => {
    try {
      const body = JSON.parse(raw);
      const translated = toResponses(body);
      const size = measure(translated);
      const problems = violations(request, body, size.images);
      if (problems.length) throw new Error(`Z.ai wire check failed: ${problems.join('; ')}`);
      const visualReview = translated.tools.length === 1 && translated.tools[0].name === 'record_visual_observations';
      const unit = visualReview || /VisLex internal analysis unit [0-9a-f]{64}/.test(JSON.stringify(translated.input));
      const toolNames = translated.tools.map(tool => tool.name);
      const flags = { text_only_notice: translated.instructions.includes('YOUR MODEL IS TEXT-ONLY'), image_tools: toolNames.filter(name => name.startsWith('inspect_')).length };
      // Chat turns: the stand-in answers through finish_task without assessing evidence.
      const { kind, call } = unit ? next(translated) : { kind: 'chat', call: toolNames.includes('finish_task')
        ? { call_id: randomUUID(), name: 'finish_task', arguments: JSON.stringify({ answer: 'Synthetic chat answer; no evidence was assessed.', blocks: null, citations: [], gaps: ['Synthetic stand-in provider'] }) }
        : null };
      requests.push({ at: Date.now(), kind, tool: call?.name ?? 'text', model: body.model, ...flags, ...size });
      if (!call) {
        const id = `zai-${randomUUID()}`;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.write(chunk({ id, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic chat answer; no evidence was assessed.' } }] }));
        response.end(chunk({ id, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: size.estimated_input_tokens, completion_tokens: 20 } }) + 'data: [DONE]\n\n');
        return;
      }
      const id = `zai-${randomUUID()}`;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write(chunk({ id, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Synthetic hidden reasoning.' } }] }));
      response.write(chunk({ id, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ id: call.call_id, type: 'function', index: 0, function: { name: call.name, arguments: call.arguments } }] } }] }));
      response.write(chunk({ id, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: size.estimated_input_tokens, completion_tokens: 200, total_tokens: size.estimated_input_tokens + 200 } }));
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(String(error).slice(0, 800));
      response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: '1210', message: String(error).slice(0, 300) } }));
    }
  });
}).listen(port, '127.0.0.1');
