# Westlaw page survey (R36)

The research browser needs Westlaw-specific selectors for four things: the search box, result rows, the opinion text, and KeyCite labels. It also needs the selectors for Westlaw's editorial regions, so that captures can exclude headnotes and key numbers. These selectors can only be read from real signed-in pages.

The survey records each page's **structure** while you browse Westlaw normally. It takes about five minutes.

## What is recorded

For each page, the survey records:

- the page path, without the query string, and the page title;
- the frames on the page;
- the page's landmarks, form fields and buttons;
- elements whose id or class suggests results, documents, flags or editorial content.

Each recorded element is described by its tag, id, class, role and text length. At most 80 characters of text are kept, and only for headings, buttons, result rows and flag elements.

The survey does not record cookies, credentials, full page text or your Client ID field's value. The output file stays on this computer, under the gitignored `artifacts` folder. The survey exists only in debug builds and never runs in test mode.

## Steps

1. Build the debug app with the research feature:
   ```bash
   npm exec tauri build -- --debug --features research --no-bundle
   ```
2. Start it with the survey switched on:
   ```bash
   VISLEX_RESEARCH_SURVEY_OUTPUT="$PWD/artifacts/westlaw-survey.jsonl" src-tauri/target/x86_64-pc-windows-msvc/debug/local-evidence-desk.exe
   ```
3. Open any synthetic or test case. In Settings → Research browser, turn the browser on for that case.
4. Click the Browser icon on the left rail and sign into Westlaw in the pane yourself.
5. Browse normally, pausing a few seconds on each page:
   - the Westlaw home page;
   - one search, for example `duty of care /s negligence`, on the results list;
   - one case opinion;
   - that case's KeyCite / Negative Treatment tab;
   - one statute with its Notes of Decisions.
6. Close VisLex.

`artifacts/westlaw-survey.jsonl` then contains one line per page. Claude builds the Westlaw entry in `src-tauri/resources/research/westlaw-playbook/selectors.json` from that file and checks it against the pages you visited.
