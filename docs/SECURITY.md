# Security boundaries of this development build

The Rust coordinator owns case state and database writes. The UI invokes case operations and receives source content through an allowlisted custom protocol. It cannot invoke an unrestricted shell or arbitrary filesystem tool. Model function names/arguments are validated against task mode, selected sources/records, current restrictions, file protection and revision base.

Windows workers run in a newly created AppContainer with no capabilities and no inherited handles. A suspended process is assigned to a Job Object before resuming. The package is granted read/execute access; a private per-job directory is granted write access. The original source and database are not granted to the worker. The job terminates on timeout, excessive memory or coordinator teardown; child process creation is restricted. Temporary grants/profile cleanup are attempted through RAII. Sandbox creation failure is fatal rather than falling back to unsandboxed parsing.

AppContainer is not a claim that every Windows-readable object is inaccessible. Tests cover a private external file, attempted modification, loopback networking and actual parser execution. They do not constitute an independent sandbox audit. Runtime ACL provisioning on a clean installation remains to be verified. Job manifests replace the planned pipe transport in this version.

Imported text, metadata, HTML-like text, processor outputs and model responses are untrusted data. React renders strings as text. No HTML evidence execution, remote image loading in emails, macros, formula evaluation, arbitrary code execution, model-controlled destinations or agent evidence deletion is implemented. Unsupported structures remain unsupported, not silently claimed as reviewed.

The only application API destination is OpenAI Responses. Keys use Windows Credential Manager and are not stored in cases, backups, the renderer or worker environment. Cases default to offline and disallow text/image transmission. Offline and source restrictions are checked before preparing requests; UI cancellation is checked while waiting for the network. There is no updater, runtime model download, telemetry or source-URL fetch. WebView2/OS network behavior needs a full offline packet-capture acceptance test; no claim of system-wide network isolation is made.

API `store:false` is not a zero-retention guarantee. Permissions currently operate at source level, not selected-region/redacted-payload granularity. Reservations persist after ambiguous API failures, and the app does not retry those tasks blindly. Conservative token allowances and supplied rates are not exact provider billing limits. Usage reconciliation and provider-model capability discovery remain outstanding.

Originals use hashes and read-only filesystem flags. Working data is OS-protected plaintext. Hash-linked audit entries detect straightforward local changes but are not tamper-proof custody or proof of evidence authenticity. An OS administrator can alter data, binaries and audit histories.

Backups use age passphrase encryption over a consistent database snapshot and hashed artifact inventory. Restoration rejects unsafe paths, nonregular members, duplicate entries, hash mismatches and malformed/incomplete encrypted streams. Backup contents include restricted evidence and old revisions. Only draft text/JSON exports are supported; no redaction or safe-disclosure guarantee is made.

Before public use: independent security assessment, dependency/license review, signed distribution, adversarial parser/agent fixtures, strict-offline observation, leak checks and restore verification on a separate machine are required.
