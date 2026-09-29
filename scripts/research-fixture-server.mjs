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
  // A synthetic opinion page for research_capture (R46). The loopback playbook entry names
  // main#opinion as the document and .headnote as editorial; the capture must leave out the
  // headnote, the script, the hidden input and the unrendered paragraph, and the account chrome
  // outside the main region.
  '/opinion.html': page('Smith v. Synthetic Holdings', `
    <nav>Signed in as Synthetic User (client SYNTH-CLIENT)</nav>
    <main id="opinion">
      <h1>Smith v. Synthetic Holdings</h1>
      <p class="cite">123 F.3d 456 (9th Cir. 2001)</p>
      <div class="headnote">HEADNOTE EDITORIAL: negligence key number 272k1 synopsis</div>
      <section class="opinion-body">
        <p>OPINION</p>
        <p>A person owes a duty of reasonable care to foreseeable plaintiffs.</p>
        <p>The duty extends to conduct that creates a foreseeable risk of harm.</p>
      </section>
      <input type="hidden" name="session" value="SYNTHETIC-HIDDEN-TOKEN">
      <p style="display:none">HIDDEN PARAGRAPH MARKER</p>
      <p onclick="window.__clickedOpinion = true">Affirmed.</p>
      <script>window.__opinionMarker = 'SCRIPT MARKER 7731';</script>
    </main>`),
  // A page showing a sign-in field: the agent must refuse to type anywhere on it.
  '/signin.html': page('signin', '<main><label for="q">Search</label><input id="q" type="search"><label for="pw">Password</label><input id="pw" type="password"></main>'),
  // Attack probe: a research page framing the VisLex UI to reach its commands from a local origin.
  '/frame.html': page('frame', '<iframe id="control" src="/second.html"></iframe><iframe id="app" src="http://tauri.localhost/" width="600" height="400"></iframe>'),
};

http.createServer((request, response) => {
  const body = pages[new URL(request.url, 'http://127.0.0.1').pathname];
  response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body ?? 'not found');
}).listen(port, '127.0.0.1', () => process.stdout.write(`research fixture on ${port}\n`));
