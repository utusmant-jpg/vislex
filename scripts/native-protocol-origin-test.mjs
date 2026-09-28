// Native WebView regression: a foreign origin must not read case media bytes.
const [port, workspace] = process.argv.slice(2);
if (!port || !workspace) throw new Error('Port and workspace are required');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === 'page' && item.title === 'VisLex') ?? targets.find(item => item.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error('VisLex WebView unavailable');
const socket = new WebSocket(target.webSocketDebuggerUrl);
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
async function evaluate(expression) {
  const packet = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (packet.exceptionDetails) throw new Error(packet.exceptionDetails.exception?.description ?? packet.exceptionDetails.text);
  return packet.result?.value;
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke)').catch(() => false);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Tauri bridge unavailable');
  const root = workspace.replaceAll('\\', '/');
  const run = Date.now().toString();
  const prepared = await evaluate(`(async()=>{
    const invoke=(action,args={})=>window.__TAURI_INTERNALS__.invoke('command',{action,args});
    const c=await invoke('create_case',{path:${JSON.stringify(root + '/artifacts/protocol-origin-' + run)},name:'Synthetic protocol origin'});
    const session={case_id:c.id,session_epoch:c.session_epoch};
    await invoke('save_settings',{...session,settings:{...c.settings,offline:true,allow_text:false,allow_images:false}});
    const imported=await invoke('import_files',{...session,paths:[${JSON.stringify(root + '/fixtures/generated/photograph.png')}],production:'Synthetic protocol origin test'});
    if(imported.items.length!==1 || imported.items[0].status!=='imported')throw new Error('Synthetic import failed');
    const s=await invoke('snapshot');
    const source=s.sources.find(x=>x.kind==='image');
    if(!source)throw new Error('Synthetic image missing');
    const url='http://evidence.localhost/'+source.id;
    const image=new Image();
    image.src=url;
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;});
    return {app_origin:location.origin,url,preview_width:image.naturalWidth,offline:s.settings.offline};
  })()`);
  if (!prepared.offline || prepared.preview_width <= 0) throw new Error('App preview did not load offline synthetic image');
  await call('Page.enable');
  await call('Page.navigate', { url: 'data:text/html,<title>Foreign origin probe</title>' });
  let foreignOrigin = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    foreignOrigin = await evaluate('location.origin').catch(() => '');
    if (foreignOrigin === 'null') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (foreignOrigin !== 'null') throw new Error('Foreign-origin navigation was not established');
  const probe = await evaluate(`(async()=>{try{
    const response=await fetch(${JSON.stringify(prepared.url)});
    const bytes=(await response.arrayBuffer()).byteLength;
    return {readable:true,status:response.status,bytes};
  }catch{return {readable:false};}})()`);
  if (probe.readable) throw new Error(`Foreign origin read ${probe.bytes} synthetic evidence bytes (HTTP ${probe.status})`);
  process.stdout.write(JSON.stringify({ app_preview: true, foreign_origin: foreignOrigin, foreign_read_blocked: true }) + '\n');
} finally {
  socket.close();
}
