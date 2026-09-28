# R20 ChatGPT subscription compatibility — 2026-09-22

State: **account-only integration implemented; subscription task execution blocked**.
This is not R20 acceptance, legal accuracy, or a packaged release result.

## Official protocol checked

- [Codex authentication](https://learn.chatgpt.com/docs/auth) distinguishes ChatGPT subscription access from API-key access.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) documents the managed browser login, `account/read`, `account/rateLimits/read`, `model/list` with account-specific `supportedReasoningEfforts`, and `turn/start`.
- The same App Server document calls client-supplied `dynamicTools` and `item/tool/call` **experimental**. It also exposes filesystem and command methods. A process that can see a case folder would bypass VisLex's case-scoped tool and AppContainer boundaries.

## Implemented slice

- Dedicated `CODEX_HOME` for an account-only App Server process; no API key or case path is passed to it. Browser login, cancel, account status, sign-out, model/effort discovery, and subscription limit reads have app commands and Settings controls.
- Global route preference defaults to API keys. Subscription execution is visibly disabled. If a subscription route is present on disk, task start, resume, running dispatch, and automatic AI review refuse API fallback.
- Selected subscription model/effort are saved only after the live account catalogue confirms the pair. No hard-coded effort menu is used.

## Release blockers

1. R19 and R24 are pending, with their own queue prerequisites. The existing Responses-shaped VisLex agent cannot safely be translated into a Codex turn simply by changing credentials.
2. No Windows process boundary has yet been shown to keep App Server's filesystem, shell, and network methods away from case originals and unrelated user files while allowing its OpenAI connection and browser callback. The existing worker AppContainer has no network capability and cannot be treated as proof for Codex.
3. No production-path dynamic tool adapter, task-route snapshot, image/tool receipt mapping, cancellation mapping, automatic-review integration, or packaged synthetic journey exists. The installed development CLI (`codex-cli 0.155.0-alpha.16`) is not a bundled runtime for users.
4. This checkout lacks the packaged worker resources. Desktop Rust compilation used a temporary resource placeholder that was removed afterward; it is not a packaging or AppContainer test.

The next implementation must establish the Windows boundary first, then bridge only approved VisLex tools and test all case grants, restricted derivatives, publication, cancellation, and zero API fallback with synthetic evidence. Keep subscription execution disabled until those tests pass. Do not use an unofficial ChatGPT endpoint or copied browser tokens as a substitute.
