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

// ---- Westlaw-shaped pages for research_westlaw_search / research_westlaw_document ----
// Synthetic cases and citations only, laid out like the Westlaw Advantage pages the agent reads:
// a global search box named "Search suggestions available after typing 3 characters. ...",
// results as list items under "N. Title" level-3 headings linking to /Document/<id>/View/FullText.html,
// each followed by a court/date/citation block (text nodes that run together in innerText), a
// summary and snippet links; documents with a KeyCite flag icon, KeyCite tabs with counts, a
// header whose citations run together, and an "All Citations" line at the end.
const westlawHeader = `
    <header>
      <form action="/westlaw-results.html" method="get" role="search">
        <input id="searchInputId" name="q" type="text" role="combobox" autocomplete="off" aria-expanded="false"
          aria-label="Search suggestions available after typing 3 characters. Use down arrow to access.">
        <button type="submit" aria-label="Search Westlaw Advantage">Search</button>
        <button type="button" aria-label="Select jurisdiction">Jurisdiction: Ohio</button>
      </form>
    </header>
    <script>
      // Like Westlaw, the search box shows the query that produced the page.
      document.getElementById('searchInputId').value = new URLSearchParams(location.search).get('q') ?? '';
    </script>`;
const results = [
  {
    id: 'ISYNTHETIC0001', title: 'Synthetic City v. Example Holdings', flag: 'Yellow Flag - Negative Treatment',
    cite: ['Court of Appeals of Ohio, Ninth District, Summit County.', 'June 20, 2031', 'Not Reported in N.E.2d', '2031 -Ohio- 1234', '2031 WL 7654321'],
    summary: 'Synthetic summary: retaining property knowing it was obtained by theft satisfies the offense.',
    snippets: ['... a person who retains property of another knowing it was obtained by theft ...', '... the lawful owner did not consent to the retention ...'],
  },
  {
    id: 'ISYNTHETIC0002', title: 'State v. Synthetic Defendant', flag: null,
    cite: ['Supreme Court of Ohio.', 'March 3, 2030', '901 N.E.3d 101', '2030 -Ohio- 55'],
    summary: 'Synthetic summary: the elements of theft by deception are construed narrowly.',
    snippets: ['... deception as to the owner of the property ...'],
  },
];
const resultItem = (row, index) => `
        <li>
          <div>
            <input type="checkbox" aria-label="Select document ${index + 1}">
            ${row.flag ? `<span role="img" title="${row.flag}" aria-label="${row.flag}">&#9873;</span>` : ''}
            <h3>${index + 1}. <a href="/Document/${row.id}/View/FullText.html?originationContext=Search&amp;rank=${index + 1}">${row.title}</a></h3>
          </div>
          <div>${row.cite.map(part => `<span>${part}</span>`).join('')}</div>
          <div>${row.summary}</div>
          <div>${row.snippets.map((text, n) => `<a href="/Document/${row.id}/View/FullText.html?originationContext=Search#co_snip_${n + 1}">${text}</a>`).join('<br>')}</div>
        </li>`;
Object.assign(pages, {
  '/westlaw-home.html': page('Home | Westlaw Advantage', `${westlawHeader}
    <main><h1>Westlaw Advantage (synthetic fixture)</h1><p>Enter a query above.</p></main>`),
  '/westlaw-results.html': page('Search Results | Westlaw Advantage', `${westlawHeader}
    <nav aria-label="Content types">
      <ul>
        <li><a href="/westlaw-results.html?view=overview">Overview (120)</a></li>
        <li><a href="/westlaw-results.html?type=cases">Cases (66)</a></li>
        <li><a href="/westlaw-results.html?type=statutes">Statutes &amp; Court Rules (12)</a></li>
        <li><a href="/westlaw-results.html?type=secondary">Secondary Sources (40)</a></li>
      </ul>
    </nav>
    <main>
      <h2>Cases (66)</h2>
      <ol id="results">${results.map(resultItem).join('')}
      </ol>
    </main>
    <script>
      // A query containing "nohits" finds nothing.
      if ((new URLSearchParams(location.search).get('q') ?? '').includes('nohits')) {
        document.querySelector('main').innerHTML = '<h2>Cases (0)</h2><p>No documents found.</p>';
      }
    </script>`),
});
const documentPage = page('Synthetic City v. Example Holdings | Westlaw Advantage', `${westlawHeader}
    <div>
      <span role="img" title="Red Flag - Severe Negative Treatment" aria-label="Red Flag - Severe Negative Treatment">&#9873;</span>
      <ul role="tablist" aria-label="KeyCite">
        <li role="tab"><a href="/Document/ISYNTHETIC0001/View/FullText.html">Document</a></li>
        <li role="tab"><a href="/RelatedInformation/ISYNTHETIC0001/kcNegativeTreatment.html">Negative Treatment (1)</a></li>
        <li role="tab"><a href="/RelatedInformation/ISYNTHETIC0001/kcHistory.html">History (2)</a></li>
        <li role="tab"><a href="/RelatedInformation/ISYNTHETIC0001/kcCitingReferences.html">Citing References (9)</a></li>
      </ul>
    </div>
    <main id="opinion">
      <h1>Synthetic City v. Example Holdings</h1>
      <div><span>Court of Appeals of Ohio, Ninth District, Summit County.</span><span>June 20, 2031</span><span>Not Reported in N.E.2d</span><span>2031 WL 7654321</span><span>2031 -Ohio- 1234</span><span>(Approx. 3 pages)</span></div>
      <p>CHECK OHIO SUPREME COURT RULES FOR REPORTING OF OPINIONS AND WEIGHT OF LEGAL AUTHORITY.</p>
      <div class="synopsis">SYNOPSIS EDITORIAL: synthetic synopsis text</div>
      <h2>Opinion</h2>
      <p>SYNTHETIC, Judge.</p>
      <p>A person who retains property of another, knowing it was obtained by theft, commits theft.</p>
      <p>The owner's lack of consent may be shown by circumstantial evidence.</p>
      <p>The judgment is affirmed.</p>
      <h2>All Citations</h2>
      <p>Not Reported in N.E.2d, 2031 WL 7654321, 2031 -Ohio- 1234</p>
    </main>`);
pages['/westlaw-document.html'] = documentPage;

http.createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const body = pages[path] ?? (/^\/Document\/I[A-Za-z0-9]+\/View\/FullText\.html$/.test(path) ? documentPage : undefined);
  response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body ?? 'not found');
}).listen(port, '127.0.0.1', () => process.stdout.write(`research fixture on ${port}\n`));
