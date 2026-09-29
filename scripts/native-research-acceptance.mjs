// R51 native mock journey, end to end in a synthetic case against the loopback fixture only:
// the Browser view opens the pane on the fixture's sign-in page and the agent refuses to act on
// it; the user moves the pane on; the agent searches, reads, opens the opinion, captures the
// quoted lines and finishes through finish_task citing the capture; the reviewer accepts the
// authority only with the four-item cite-check; the dossier exports; the bundle holds the
// opinion's words and none of the fixture's editorial or hidden strings; the research page has
// no Tauri IPC or evidence access; and this script only ever drives the VisLex target.
// The model is research-provider-mock.mjs in journey mode. Writes one JSON result on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [port, workspace, fixturePort, screenshotPath, providerPort] = process.argv.slice(2);
if (!port || !workspace || !fixturePort || !screenshotPath || !providerPort) throw new Error('Arguments: port workspace fixturePort screenshot providerPort');
const fixture = `http://127.0.0.1:${fixturePort}`;
const root = workspace.replaceAll('\\', '/');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The fixture's editorial, script, hidden and account strings (research-fixture-server.mjs /opinion.html).
const EDITORIAL = ['HEADNOTE EDITORIAL', 'key number 272k1', 'SCRIPT MARKER', 'SYNTHETIC-HIDDEN-TOKEN', 'HIDDEN PARAGRAPH MARKER', 'Signed in as', 'SYNTH-CLIENT'];
const OPINION = 'A person owes a duty of reasonable care to foreseeable plaintiffs.';

// Same rule as native-cdp-eval.mjs: only the page titled exactly 'VisLex', never a fallback.
const isApp = item => item.type === 'page' && item.title === 'VisLex';
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).map(item => ({ type: item.type, title: item.title, url: item.url, id: item.id }));

async function connect() {
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    target = (await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())).find(isApp);
    if (!target) await sleep(200);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('VisLex target unavailable');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
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
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return { target: { id: target.id, title: target.title, url: target.url }, call, evaluate, close: () => socket.close() };
}

let app;
/** One app command through the main webview's bridge: { ok, value } or { ok: false, error }. */
const command = (action, args = {}) => app.evaluate(`window.__TAURI_INTERNALS__.invoke('command', ${JSON.stringify({ action, args })}).then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) }))`);
async function must(action, args) {
  const result = await command(action, args);
  if (!result.ok) throw new Error(`${action}: ${result.error}`);
  return result.value;
}
async function waitFor(probe, label, tries = 150, interval = 200) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await probe(); if (value) return value; } catch { /* navigating or reloading */ }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const probe = go => must('research_debug_probe', { go: go ?? null });
async function bridgeReady() {
  await waitFor(() => app.evaluate('Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector(".rail-button"))'), 'the VisLex UI', 100, 100);
}
/** Runs one chat task to its end. `during(taskId)` is polled while it runs; once it returns
 *  true it is not called again. */
async function runTask(session, prompt, during) {
  const started = await must('start_task', { ...session, prompt });
  let done = !during;
  const task = await waitFor(async () => {
    if (!done) done = await during(started.task_id);
    const item = (await must('snapshot')).tasks.find(entry => entry.id === started.task_id);
    return item && item.status !== 'running' ? item : null;
  }, `task "${prompt.slice(0, 40)}"`, 900, 200);
  if (!done) throw new Error('The task ended before its in-run step happened');
  const actions = await must('actions', { case_id: session.case_id, task_id: started.task_id });
  return { task, actions };
}
const summary = action => ({ name: action.name, status: action.status, input: action.input.slice(0, 200), output: action.output.slice(0, 300) });
const parse = text => { try { const value = JSON.parse(text); return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };

const result = { ok: false, checks: {}, steps: {} };
const check = (name, passed, detail) => { result.checks[name] = { passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) }; if (!passed) throw new Error(`Check failed: ${name}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 600)})`}`); };
try {
  app = await connect();
  await bridgeReady();

  // cdp-eval selects the VisLex target by exact title only, as this script does.
  const evalSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-cdp-eval.mjs'), 'utf8');
  check('cdp_eval_selects_vislex_by_title_only', evalSource.includes("item.type === 'page' && item.title === 'VisLex'") && !/targets\[0\]|\?\?\s*targets/.test(evalSource));
  check('selected_target_is_the_app', app.target.title === 'VisLex' && !app.target.url.startsWith(fixture), app.target);

  // A synthetic case, online, with the research browser switched on.
  const run = Date.now().toString();
  const existing = await must('snapshot');
  const switching = existing ? { case_id: existing.id, session_epoch: existing.session_epoch } : {};
  const created = await must('create_case', { ...switching, path: `${root}/artifacts/research-acceptance-${run}`, name: `Synthetic research acceptance ${run}` });
  let session = { case_id: created.id, session_epoch: created.session_epoch };
  await must('save_settings', { ...session, settings: { ...created.settings, offline: false, allow_text: true, model: 'gpt-4.1' } });
  await must('set_research_grant', { ...session, enabled: true, sso_hosts: [] });
  await app.call('Page.reload', { ignoreCache: false });
  await sleep(500);
  await bridgeReady();
  const snapshot = await must('snapshot');
  session = { case_id: snapshot.id, session_epoch: snapshot.session_epoch };
  result.steps.case = session;

  // The Browser rail button opens the pane; it starts on the fixture's sign-in page.
  await app.evaluate(`(async () => {
    const rail = () => [...document.querySelectorAll('button.rail-button')].find(button => button.getAttribute('aria-label') === 'Browser');
    for (let i = 0; i < 50 && !rail(); i++) await new Promise(r => setTimeout(r, 100));
    rail().click();
  })()`);
  await waitFor(async () => { const state = await must('research_pane_state'); return state.open && state.case_id === session.case_id; }, 'the research pane to open');
  const signin = await waitFor(async () => { const page = await probe(); return page?.url?.endsWith('/signin.html') ? page : null; }, 'the sign-in page');
  result.steps.pane_opened = signin;
  const listed = await targets();
  result.steps.targets_with_pane = listed;
  check('research_page_is_never_the_vislex_target', listed.filter(isApp).every(item => !item.url.startsWith(fixture)) && listed.filter(item => item.url.startsWith(fixture)).every(item => !isApp(item)), listed);
  check('chat_beside_the_pane', await app.evaluate('Boolean(document.querySelector(".research-split .research-split-chat textarea, .research-split .research-split-chat [contenteditable=true]"))'));

  // The agent checks the page, sees the sign-in fields, is refused typing, and stops for the user.
  const first = await runTask(session, 'JOURNEY-SIGNIN Check the research browser, then search for the duty of care.');
  const firstResearch = first.actions.filter(action => action.name.startsWith('research_'));
  result.steps.signin_task = { status: first.task.status, answer: first.task.answer, actions: firstResearch.map(summary) };
  const status = firstResearch.find(action => action.name === 'research_status');
  const statusOutput = parse(status?.output ?? '') ?? {};
  // In test mode the navigation policy has one loopback origin, so the fixture's sign-in page is
  // on the research site; research_status reports that value as it is.
  result.steps.signin_status = { on_research_site: statusOutput.on_research_site ?? null, host: statusOutput.host ?? null, url: statusOutput.url ?? null };
  const typed = firstResearch.find(action => action.name === 'research_act');
  check('agent_refused_to_type_on_the_sign_in_page', typed?.status === 'failed' && /sign-in or verification field|credential/i.test(typed.output), typed && summary(typed));
  check('no_research_action_succeeded_on_the_sign_in_page', firstResearch.filter(action => action.name === 'research_act').every(action => action.status === 'failed'));
  check('agent_stopped_and_asked_the_user', first.task.status === 'complete' && /sign-in page is showing/.test(first.task.answer), first.task.status);
  check('sign_in_page_left_in_place', (await probe())?.url?.endsWith('/signin.html'));

  // The user moves the pane on (a page script navigation, as a user click would).
  await probe('second');
  result.steps.after_user_navigation = await waitFor(async () => { const page = await probe(); return page?.url?.endsWith('/second.html') ? page : null; }, 'the pane to leave the sign-in page');

  // The authority is accepted only with the four-item cite-check. The reviewer does it as soon as
  // the capture appears, while the task still runs: the synthetic model waits for the release
  // before declaring its dossier. (Accepting after finish_task changes the evidence stamp the
  // finished dossier was checked against, so the claim review and export are then refused with
  // "Evidence changed; recheck dossier before approval"; see the R51 notes.)
  let citeCheckError = null;
  const citeCheck = async capture => {
    const authority = await must('evidence_read', { ...session, id: capture.authority_id });
    check('authority_is_unreviewed_research_evidence', authority.kind === 'authority' && authority.review === 'unreviewed' && authority.actor === 'research_browser_adapter', { kind: authority.kind, review: authority.review, actor: authority.actor });
    const leakedIntoAuthority = EDITORIAL.filter(marker => String(authority.content).includes(marker));
    check('authority_has_no_editorial_text', leakedIntoAuthority.length === 0, leakedIntoAuthority);
    const withoutChecks = await command('evidence_review', { ...session, id: authority.id, revision: authority.revision, review: 'accepted' });
    check('accept_without_cite_check_refused', !withoutChecks.ok && /cite-check/i.test(withoutChecks.error), withoutChecks);
    const partial = await command('evidence_review', { ...session, id: authority.id, revision: authority.revision, review: 'accepted', checks: ['exists', 'quote', 'citator'] });
    check('accept_with_three_checks_refused', !partial.ok && /cite-check/i.test(partial.error), partial);
    await must('evidence_review', { ...session, id: authority.id, revision: authority.revision, review: 'accepted', checks: ['exists', 'quote', 'citator', 'support'] });
    const accepted = await must('evidence_read', { ...session, id: authority.id });
    check('authority_accepted_after_cite_check', accepted.review === 'accepted', accepted.review);
  };
  const citeCheckWhileRunning = async taskId => {
    const captured = (await must('actions', { case_id: session.case_id, task_id: taskId })).find(action => action.name === 'research_capture' && action.status === 'complete');
    if (!captured) return false;
    try { await citeCheck(parse(captured.output) ?? {}); } catch (error) { citeCheckError = error; }
    result.steps.provider_holding_at_cite_check = (await fetch(`http://127.0.0.1:${providerPort}/state`).then(response => response.json())).holding;
    await fetch(`http://127.0.0.1:${providerPort}/release`, { method: 'POST' });
    return true;
  };

  // The agent searches, reads, opens the opinion, reads it, captures, and finishes citing the capture.
  const second = await runTask(session, 'JOURNEY-RESEARCH Research the duty of care in the research browser and cite the opinion.', citeCheckWhileRunning);
  if (citeCheckError) throw citeCheckError;
  const secondActions = second.actions.map(summary);
  result.steps.research_task = { status: second.task.status, answer: second.task.answer, actions: secondActions };
  const names = second.actions.filter(action => action.status === 'complete').map(action => action.name);
  const order = ['research_navigate', 'research_act', 'research_act', 'research_read_page', 'research_navigate', 'research_read_page', 'research_capture', 'save_dossier', 'finish_task'];
  let cursor = 0;
  for (const name of names) if (name === order[cursor]) cursor += 1;
  check('journey_steps_in_order', cursor === order.length, names);
  check('no_research_step_failed', second.actions.filter(action => action.name.startsWith('research_')).every(action => action.status === 'complete'), secondActions.filter(action => action.status !== 'complete'));
  const typedQuery = second.actions.find(action => action.name === 'research_act' && parse(action.input)?.action === 'type');
  check('search_typed_verbatim', parse(typedQuery?.input ?? '')?.text === 'duty of care /s negligence');
  const captureAction = second.actions.find(action => action.name === 'research_capture' && action.status === 'complete');
  const capture = parse(captureAction?.output ?? '') ?? {};
  check('capture_is_citable', /^evidence:[^#]+#R\d+L\d+-L\d+$/.test(capture.locator ?? ''), capture);
  check('finish_task_cites_the_capture', second.task.status === 'complete' && second.task.answer.includes(capture.locator), { status: second.task.status, answer: second.task.answer });
  const finishes = second.actions.filter(action => action.name === 'finish_task').map(action => parse(action.output)?.status ?? action.status);
  result.steps.finish_statuses = finishes;
  check('finish_passed_the_support_review', finishes.at(-1) === 'complete' && finishes.includes('review_required'), finishes);
  check('authority_still_accepted_after_finish', (await must('evidence_read', { ...session, id: capture.authority_id })).review === 'accepted');

  // The reviewer accepts the finding and exports the dossier.
  const view = await must('read_dossier', { ...session, task_id: second.task.id });
  result.steps.dossier = { revision: view.dossier?.revision, claims: view.dossier?.claims?.length, stale: view.stale, completion_stale: view.completion_stale, outcome: view.completion?.outcome };
  await must('review_dossier_claim', { ...session, task_id: second.task.id, revision: view.dossier.revision, claim_index: 0, decision: 'accepted', note: 'Synthetic review of the captured opinion lines.' });
  const bundle = `${root}/artifacts/research-acceptance-package-${run}`;
  const exported = await must('export_dossier_bundle', { ...session, task_id: second.task.id, path: bundle });
  result.steps.export = exported;
  const files = [];
  const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); entry.isDirectory() ? walk(full) : files.push(full); } };
  walk(bundle);
  const contents = files.map(file => ({ file: path.relative(bundle, file).replaceAll('\\', '/'), text: fs.readFileSync(file, 'latin1') }));
  result.steps.bundle_files = contents.map(item => ({ file: item.file, bytes: item.text.length }));
  const opinionFiles = contents.filter(item => item.text.includes(OPINION)).map(item => item.file);
  check('bundle_contains_the_opinion_text', opinionFiles.some(file => file.startsWith('evidence/')), opinionFiles);
  const leaked = contents.flatMap(item => EDITORIAL.filter(marker => item.text.includes(marker)).map(marker => `${item.file}: ${marker}`));
  check('bundle_has_no_editorial_or_hidden_strings', leaked.length === 0, leaked);
  check('bundle_cites_the_capture', contents.some(item => item.file === 'index.html' && item.text.includes(capture.locator)));

  // The research conversation, opened in the Browser view, lists the saved steps in plain words.
  const shownSteps = await app.evaluate(`(async () => {
    const wait = async (probe, tries = 100) => { for (let i = 0; i < tries; i++) { const found = probe(); if (found) return found; await new Promise(r => setTimeout(r, 100)); } return null; };
    const chat = await wait(() => [...document.querySelectorAll('button.chat-open')].find(button => (button.title || button.textContent).startsWith('JOURNEY-RESEARCH')));
    if (!chat) return { error: 'research chat not listed' };
    chat.click();
    const toggle = await wait(() => [...document.querySelectorAll('.conversation-turn .trace-toggle')].at(-1));
    if (!toggle) return { error: 'no activity toggle' };
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const list = await wait(() => { const found = document.querySelector('.conversation-turn [aria-label="Recorded actions"]'); return found && found.textContent.includes('Captured') ? found : null; });
    return { browser_view: Boolean(document.querySelector('.research-split')), text: list ? list.innerText : '' };
  })()`);
  result.steps.chat_steps = shownSteps;
  // Read steps name the line numbers the page actually returned (the fixture pages are short).
  const shownText = String(shownSteps.text ?? '').replace(/\s+/g, ' ');
  check('native_chat_shows_research_steps', shownSteps.browser_view && ['Searched: duty of care /s negligence', `Opened 127.0.0.1:${fixturePort}/opinion.html`, 'Captured 123 F.3d 456'].every(label => shownText.includes(label)) && /Read lines 0–\d+/.test(shownText), shownSteps);

  // Screenshot of the Browser view with the finished conversation beside the pane.
  await app.call('Page.enable');
  const screenshot = await app.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  result.steps.targets_after_research = await targets();
  check('research_page_never_selected_after_research', (await targets()).filter(isApp).length === 1 && (await targets()).filter(isApp).every(item => !item.url.startsWith(fixture)), result.steps.targets_after_research);

  // Isolation of the research page, measured through the in-process bridge (debug R34 spike,
  // test mode only): no Tauri IPC and no evidence protocol from the child webview.
  await must('close_research_pane');
  const spike = await must('research_spike', { url: `${fixture}/index.html`, profile: `${root}/artifacts/research-acceptance-spike-profile-${run}` });
  const isolation = spike.isolation ?? {};
  result.steps.isolation = isolation;
  // Tauri injects its IPC bridge object into every webview it creates, including the child; what
  // matters is that no command is allowed from the research origin. Recorded, not asserted.
  result.steps.child_tauri_internals_type = isolation.tauri_internals ?? null;
  check('child_cannot_invoke_commands', typeof isolation.invoke === 'string' && isolation.invoke.startsWith('refused'), isolation.invoke);
  check('child_cannot_fetch_evidence', typeof isolation.evidence_fetch === 'string' && !/^status 2\d\d/.test(isolation.evidence_fetch), isolation.evidence_fetch);
  result.steps.framed_app_attack = spike.framed_app_attack ?? null;
  check('framed_vislex_ui_cannot_invoke', typeof spike.framed_app_attack?.invoke_from_frame !== 'string' || !spike.framed_app_attack.invoke_from_frame.startsWith('allowed'), spike.framed_app_attack);
  result.ok = true;
} catch (error) {
  result.error = String(error?.message ?? error);
} finally {
  app?.close();
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
