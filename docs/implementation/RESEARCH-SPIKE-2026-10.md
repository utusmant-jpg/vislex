# Research browser spike (R33–R34)

Branch `claude/research-browser`, base `8b2fbee`. Run 2026-09-28.

## Environment

| Item | Value |
|---|---|
| OS | Windows 11 Home, build 26200 |
| Hardware | Snapdragon X X1E80100 (ARM64), 15.6 GB RAM. The x64 build runs under emulation, so latencies include emulation overhead. |
| WebView2 runtime | 153.0.4234.48 (user agent reports Edg/153) |
| Tauri stack | tauri 2.12.0, tauri-runtime-wry 2.12.0, wry 0.57.0, webview2-com 0.39.1, windows 0.62.2; `tauri/unstable` is enabled by the `research` feature |
| Build | `npm exec tauri build -- --debug --features research --no-bundle` |

## How it was run

Both runs use only the synthetic loopback fixture `scripts/research-fixture-server.mjs`. No case data is involved and no real site is contacted.

- **Port mode** (`scripts/native-research-spike.ps1`): uses the existing native-test setup, with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port` and `WEBVIEW2_USER_DATA_FOLDER` set. The main webview invokes the debug-only `research_spike` action. The run fails if the report says `ok: false`.
- **Startup mode** (`scripts/native-research-spike-startup.ps1`): neither variable is set. The debug test-mode app runs the spike itself at startup, writes `artifacts/research-spike-startup.json`, and exits non-zero on failure. This is the configuration a user build has.

The spike code is `src-tauri/src/research/spike.rs`. It is compiled only with `research` + Windows + `debug_assertions`; `cargo check --release --features research` passes without it. It runs only when `VISLEX_TEST_MODE=1` and a loopback `VISLEX_RESEARCH_MOCK_URL` are set. A run fails (`ok: false`, non-zero exit) unless every isolation invariant below held:
- the research page and the framed probe cannot invoke commands;
- the evidence fetch fails;
- the blocked navigation does not proceed;
- no pop-up webview appears;
- in startup mode, the pane uses its own profile.

## Results (startup mode unless noted)

**In-process DevTools protocol, no port.** Calls go through `Webview::with_webview` → `ICoreWebView2::CallDevToolsProtocolMethod`, 50 calls each:

| Method | Works | p50 ms | p95 ms |
|---|---|---|---|
| `Runtime.evaluate` | yes | 0.29 | 0.61 |
| `DOM.getDocument` | yes | 0.31 | 0.53 |
| `DOM.describeNode` | yes | 0.30 | 0.49 |
| `DOM.getBoxModel` | yes | 0.25 | 0.52 |
| `DOM.getOuterHTML` | yes | 0.31 | 0.43 |

These worked when called once:

| Method | Time |
|---|---|
| `Page.enable` | – |
| `Page.getFrameTree` | – |
| `Page.captureSnapshot` (MHTML) | 6.5 ms; 75 ms in port mode |
| `Accessibility.getFullAXTree` | 3.1 ms |
| `DOMSnapshot.captureSnapshot` | 1.4 ms |
| `Target.setAutoAttach` (flatten) | – |

`Browser.getBrowserCommandLine` is refused ("--enable-automation not set"), so the effective switches cannot be read back.

**UI thread.** 100 sequential calls: median 0.26 ms, p95 0.42 ms. `set_position`, `set_size`, `show` and `hide` all work, and a hidden webview still evaluates.

**Isolated world.**
- `Page.createIsolatedWorld` works.
- `Runtime.callFunctionOn` in that world reads the DOM (it returned `document.title`).
- A global set in the world is invisible to page script (`typeof` returns `undefined`).

**Input.**
- `DOM.focus` followed by `Input.insertText` types the query.
- A trusted click works only if `Input.dispatchMouseEvent` sends `mouseMoved` before `mousePressed` and `mouseReleased`; without `mouseMoved` it did not register.
- The `DOM.getBoxModel` centre hit-tests to the target button.
- An element click through the isolated world also works, but the event is untrusted.

**Isolation of the child webview.**
- `window.__TAURI_INTERNALS__` exists in the research page, because Tauri injects it, so sites can detect the embedding.
- `invoke('command', …)` from the research page is refused ("command not allowed"). The refusal comes from Tauri's rule for remote origins: the app has no command ACL manifest, so capability scoping alone does not gate app commands. The command handler now also rejects any webview label other than `main`. Native acceptance passed with that check in place, which confirms the app webview is labelled `main`.
- **Framed-app probe.** The fixture page `/frame.html` embeds a same-origin control iframe and an iframe of `http://tauri.localhost/`, the VisLex UI.
  - The control frame appears in `Page.getFrameTree`.
  - The VisLex frame never does, so no VisLex execution context exists inside the research pane.
  - The probe does not isolate which layer blocks the frame: `frame-ancestors 'none'`, now in the app CSP, or protocol handling in the child webview. The label check remains as a further layer.
- A `fetch` of `http://evidence.localhost/…` from the research page fails. The evidence handler also refuses any webview label other than `main`.
- `window.open` is denied, and no second research webview is created.

**Navigation.**
- `on_navigation` governs top-level navigations, including CDP `Page.navigate`: a navigation to a host outside the allowlist returned `net::ERR_ABORTED` and the URL did not change.
- wry registers only `NavigationStarting`, so iframe navigations are **not** filtered by this allowlist.
- An allowed navigation raised `Page.frameNavigated` through `GetDevToolsProtocolEventReceiver`.
- `Page.stopLoading` works.
- An allowed `Page.navigate` took about 1.7 s end-to-end on the fixture.

**Profile isolation.**
- In startup mode, WebView2's effective user data folder, read through `ICoreWebView2Environment7::UserDataFolder`, is the pane's own profile, which holds a separate `EBWebView`.
- In port mode, `WEBVIEW2_USER_DATA_FOLDER` overrides the pane's `data_directory`.
- In port mode, no `DevToolsActivePort` file appears in the profile even though a port is active, so an active listener cannot be detected from the profile.

The pane therefore enforces the following:
- **Before creation:** it refuses to open while any of these is present:
  - a debugging switch (any `-`, `--` or `/` prefix) or a `user-data-dir` switch in the browser arguments;
  - `WEBVIEW2_USER_DATA_FOLDER`, `WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER` or `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` in the environment;
  - the WebView2 `AdditionalBrowserArguments` or `UserDataFolder` registry policies. A registry read error other than "not found" counts as present.

  An administrator's `BrowserExecutableFolder` policy (a fixed-version runtime) is not refused.
- **After creation:** it confirms the effective folder equals its own profile, and otherwise closes the pane and clears its policy. `open()` reuses an existing pane only if it passed that check.
- The profile boundary canonicalizes the nearest existing ancestor, so junctions, `subst` drives and short names on a case path are resolved.

Both checks are skipped only in debug test mode against a loopback fixture.

## R33 regression evidence on the same build

| Check | Result |
|---|---|
| `cargo test --locked` (default features) | 245 passed, 0 failed (native/packaged suites ignored as usual); research unit tests: 6 passed |
| `cargo check --locked --features desktop` | passed |
| `cargo check --locked --features research` | passed |
| `cargo check --release --features research` | passed |
| `npm run build` | passed |
| `npm test` | 294 passed (30 files) |
| `node scripts/check-webview-lockstep.mjs` | the app and tauri-runtime-wry both use webview2-com 0.39.1 and windows 0.62.2; capabilities are scoped to the main webview |
| `scripts/native-acceptance.ps1` on the research build | passed |

The lockstep checker was also negative-tested. It fails when:
- the app's `windows` version differs from tauri-runtime-wry's;
- a capability is window-scoped;
- a capability names another webview;
- a capability allows remote URLs.

Native acceptance used `VISLEX_WORKER_PATH` pointing at the main checkout's built worker. The journey covered import, extraction, chat, lexical search, DOCX/PDF export, and the cross-case and unreviewed-redaction denials. `semantic_results: 0` matches the previous 2.11 run from the same day.

## Decisions taken from the spike

- **Page observation:** an injected script in an isolated world, with refs keyed by `backendNodeId`, as planned. `Accessibility.getFullAXTree` also works and can serve as a cross-check, but the plan does not depend on it.
- **Clicks:** send `mouseMoved`, then `mousePressed`, then `mouseReleased` at the box-model centre, after a hit-test confirms the element at that point.
- **Configuration refusals:** the pane refuses unsafe configurations before creation and verifies its effective profile after creation. It does not rely on a `DevToolsActivePort` marker.
- **Iframe navigations:** subframes are not covered by the navigation allowlist. Captures and agent actions must therefore operate on the main frame, or on frames whose origin the agent tools check explicitly (R42/R50).

## R35: page observation script and sizing

**Script.** `src-tauri/resources/research/injected-script.js` (321,108 bytes, sha256 `93f3fbc1…3de2`) is Playwright 1.63.0's injected script, which is Apache-2.0.
- `scripts/build-research-injected.mjs` extracts it unchanged from the locked `playwright-core`.
- `--check` proves it is reproducible and is wired into `verify-v4.ps1`.
- LICENSE, NOTICE and ThirdPartyNotices are bundled beside it.
- It evaluates to the `InjectedScript` class. Playwright itself runs this class in an isolated utility world.

**Output.** `ariaSnapshot(element, {mode: "ai"})` returns YAML with roles, accessible names, link URLs and `[ref=eN]`. `ariaSnapshotForRecorder()` also returns the ref map (element → ref).

**Ref stability.** Measured in Edge via Playwright, dev tooling only:
- after a re-render that inserts a row above existing rows, unchanged elements keep their refs;
- a replaced element gets a new ref, so a stale ref fails and the agent must re-snapshot.

**Password fields.** A password input is reported as a plain `textbox`. The credential-field guard in R42 must use DOM attributes, not the snapshot role.

**Sizing on public legal pages.** Measured in Edge via Playwright, with tokens estimated as characters ÷ 4:

| Page | Raw HTML | Full snapshot | Interactive lines only | Main landmark | Snapshot time |
|---|---|---|---|---|---|
| Google Scholar case-law results ("duty of care" negligence) | 41,585 | 4,191 | 1,334 | 3,124 | 28 ms |
| LII 42 U.S.C. § 1983 | 9,789 | 1,909 | 731 | 851 | 12 ms |

Both interactive views are under the plan's ≤3k-token target for a results page.

**Automated-browser blocking.**
- CourtListener returned a CDN 403 to the automated headless browser.
- Justia returned a Cloudflare challenge.

The research pane is a headed, user-signed-in WebView2, but sites that detect automation remain a risk. The pacing and caps apply, and a challenge must end the task and hand control back to the user.

**Not run.** Westlaw pages were not measured; that needs the developer's own signed-in account, and is part of R36.

## Not run / open

- The Linux `cargo check` for `desktop` and `research` has been added to CI but was not run locally.
- R36 (the real Westlaw DOM survey and Westlaw snapshot sizing) needs the developer's own signed-in Westlaw account and is not started.
- Cross-origin iframe sessions (`CallDevToolsProtocolMethodForSession`) were not exercised.
- Which layer blocks the framed-app probe is not isolated.
- Only one machine was measured, an ARM64 host running x64 under emulation.
- Startup mode clears `WEBVIEW2_USER_DATA_FOLDER`, so the main application webview uses the user's real VisLex WebView2 profile during that run. The research pane still uses its own temporary profile, and no case data is involved.
- The command's webview-label check is not exercised on its own. Every probe observed was refused earlier, by Tauri's remote-origin rule or by the framed page never loading.

## Native runs 2026-09-28

Tested commit `f2e7082` (includes the merge of main `2ebc7ad`), Windows 11, WebView2 Edg/153. Build: `npm exec tauri build -- --debug --features subscription,research --no-bundle`. Each script was run serially and each passed:

- `scripts/native-acceptance.ps1`: 6 fixtures, exports hashed, cross-case denials, `provider_calls` 0.
- `scripts/native-research-agent.ps1`: a real chat task navigates, types, clicks, reads, opens an opinion, reads it, calls `research_capture` and answers with the locator `evidence:<sid>#R1L4-L5`; `citation_mismatch` is false, the extract contains the opinion, the authority is unreviewed and no editorial text leaks.
- `scripts/native-research-pane.ps1`: pane commands, toggle, close on toggle-off/offline/case switch, sign-out deletes the profile.
- `scripts/native-research-spike-startup.ps1` and `scripts/native-research-spike.ps1`: in-process CDP p50 about 0.3 ms, isolated world invisible to the page, trusted click, invoke refused and evidence fetch fails in the child, password-field typing refused.

The scripts assert that the real app WebView profile is unchanged.

Not run: the Holding/`stop_if_active` runtime path, the runtime-flag-off path, and any real Westlaw page (R36). Capture refuses on real Westlaw until the R36 selector map supplies the playbook `content_root`, and the `full` snapshot scope can still return whole-page text on Westlaw document pages until then.

### Re-run at `f3d4079` (R37/R49, R45, R51, R52)

Same machine and build command. Changes since `f2e7082`: `dcd79a7` (research tools on the ChatGPT-subscription route, step detail, `research_stop`), `7278800` (reporter citations from reporters-db 3.2.66), `440b236` (citation guard), `afef5fa` (inline research steps, toolbar Stop, R51 journey) and `f3d4079` (research styles moved into the app's cascade layers). Each script was run serially and each passed:

- `scripts/native-research-acceptance.ps1` (R51, 28 checks): `cdp eval` selects only the VisLex target; the agent is refused typing on the fixture sign-in page; the capture is citable as `123 F.3d 456` with no mismatch and no editorial text; cite-check acceptance is refused with no checks and with 3, and accepted with 4; the task steps run navigate, act, act, read, navigate, read, checkpoint, read, capture, save_dossier, finish_task, review_candidate, finish_task; the dossier export contains the opinion only.
- `scripts/native-acceptance.ps1`, `native-research-agent.ps1`, `native-research-view.ps1`, `native-research-pane.ps1`, `native-research-spike-startup.ps1` and `native-research-spike.ps1`.

Other checks at the same tree: `cargo test --locked` 318 passed (run at `440b236`; `f3d4079` changed only frontend files), `cargo check --locked --features subscription,research` exit 0, `npx vitest run` 344 passed, `npm run build` exit 0, `npx playwright test` 65 passed. Before `f3d4079`, three Playwright specs failed (harness-viewer-layout twice, workspace narrow inspection); they passed on main `2ebc7ad` and were bisected to `0ca480e`, where `research.css` declared the surfaces layer ahead of the app's layer order.

Open:

- Accepting an authority's cite-check after `finish_task` changes the dossier evidence stamp, so dossier approval and export then ask for a recheck ("Evidence changed; recheck dossier before approval"). This is the existing review-state stamp design; the R51 journey does the cite-check before finishing.
- In mock mode `research_status` reports `on_research_site` true on the fixture sign-in page, because test mode has a single loopback origin. The sign-in refusal is exercised through the password-field typing rule instead.
- No signed-in ChatGPT-subscription research turn, and no live no-persistence probe with a signed-in sidecar, has been run (see `CODEX-SUBSCRIPTION-GATE.md`).
- The manual R51 journey on real Westlaw needs R36, which still waits for the user to sign into Westlaw once (`RESEARCH-SURVEY.md`).
