import http from 'node:http';

const port = Number(process.argv[2] ?? 9362);
let requests = 0;
const held = [];
const reply = (response, index) => {
  const value = {
    status: 'completed',
    usage: { input_tokens: 10, output_tokens: 5 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: `Synthetic provider answer ${index}` }] }],
  };
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: value })}\n\n`);
};
http.createServer((request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (request.url === '/state') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ requests, held: held.length }));
    return;
  }
  if (request.url === '/release' && request.method === 'POST') {
    for (const [pending, index] of held.splice(0)) reply(pending, index);
    response.writeHead(200);
    response.end('released');
    return;
  }
  if (request.url !== '/v1/responses' || request.method !== 'POST') {
    response.writeHead(404);
    response.end();
    return;
  }
  let bytes = 0;
  request.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) request.destroy(); });
  request.on('end', () => {
    const index = ++requests;
    if (index === 1) { held.push([response, index]); setTimeout(() => { const pending = held.shift(); if (pending) reply(...pending); }, 4000); }
    else reply(response, index);
  });
}).listen(port, '127.0.0.1');
