// Loopback fixture pages for the research browser spike and mock journeys. Synthetic content
// only; binds 127.0.0.1 and serves a fixed page set.
import http from 'node:http';

const port = Number(process.argv[2] ?? 9471);
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const pages = {
  '/index.html': page('fixture', `
    <main>
      <h1>Synthetic research fixture</h1>
      <label for="search">Search</label><input id="search" type="search" autocomplete="off">
      <button id="go" type="button">Search</button>
      <a id="second" href="/second.html">Second page</a>
    </main>
    <script>
      document.getElementById('go').addEventListener('click', event => {
        window.__clicked = true;
        window.__clickTrusted = event.isTrusted;
      });
    </script>`),
  '/second.html': page('second', '<main><h1>Second page</h1><p>Synthetic opinion text.</p></main>'),
  // Attack probe: a research page framing the VisLex UI to reach its commands from a local origin.
  '/frame.html': page('frame', '<iframe id="control" src="/second.html"></iframe><iframe id="app" src="http://tauri.localhost/" width="600" height="400"></iframe>'),
};

http.createServer((request, response) => {
  const body = pages[new URL(request.url, 'http://127.0.0.1').pathname];
  response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body ?? 'not found');
}).listen(port, '127.0.0.1', () => process.stdout.write(`research fixture on ${port}\n`));
