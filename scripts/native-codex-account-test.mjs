// Packaged WebView smoke: the attested sidecar answers account/read without case data.
const [port] = process.argv.slice(2);
const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const page = pages.find(item => item.type === 'page' && item.title === 'VisLex') ?? pages.find(item => item.type === 'page');
if (!page?.webSocketDebuggerUrl) throw new Error('VisLex WebView unavailable');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const packet = JSON.parse(event.data);
  if (!packet.id || !pending.has(packet.id)) return;
  const { resolve, reject } = pending.get(packet.id);
  pending.delete(packet.id);
  packet.error ? reject(new Error(JSON.stringify(packet.error))) : resolve(packet.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await call('Runtime.evaluate', { expression: 'Boolean(window.__TAURI_INTERNALS__?.invoke)', returnByValue: true }).catch(() => null);
    if (state?.result?.value === true) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Tauri bridge unavailable');
  const expression = `(async()=>{const invoke=(action)=>window.__TAURI_INTERNALS__.invoke('command',{action,args:{}});return {route:await invoke('ai_access_route'),account:await invoke('codex_account_status')}})()`;
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  const value = result.result?.value;
  if (value?.route?.subscription_ready !== true || typeof value?.account?.connected !== 'boolean') {
    throw new Error(`Packaged Codex account route unavailable: ${JSON.stringify(value)}`);
  }
  process.stdout.write(JSON.stringify({ subscription_ready: true, account_protocol: true, connected: value.account.connected }) + '\n');
} finally {
  socket.close();
}
