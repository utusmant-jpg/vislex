# Z.ai GLM Coding Plan provider (2026-10-01)

Z.ai is an API-key provider alongside OpenAI, Anthropic, Gemini, xAI and OpenRouter. It serves chat, case analysis, video and image work, delegation and the research tools through the same coordinator path as the others.

## Wire facts (from docs.z.ai, checked 2026-10-01)

- Endpoint: `https://api.z.ai/api/coding/paas/v4/chat/completions` (OpenAI Chat Completions protocol). Coding Plan keys work only on the coding endpoints.
- Models: `glm-5.3` (text only) and `glm-5.3-flash` (text, image and video input). Both have a 1M context and up to 128K output.
- Thinking cannot be disabled on GLM-5.3. VisLex sends `thinking: {type: "enabled"}` and `reasoning_effort: "max"` on every request.
- `tool_choice` accepts only `"auto"`. When the coordinator requires a tool, VisLex states it as a system directive, and the tool list is already narrowed to that tool.
- `tool_stream: true` streams tool arguments on GLM-5.x.
- Usage is reported in tokens. The plan bills in quota points, so no cost is recorded.
- The key is stored in Windows Credential Manager as `zai-api-key`, the same way as the other providers.

## Vision routing

`providers::model_sees_images` marks `glm-5.3` text-only and `glm-5.3-flash` (and the GLM "V" family) image-capable. A text-only profile never carries image permission (`task_profile` and `select_profile` clamp it), so image tools, forced visual steps and image attachments are withheld. The encoder also refuses images for a text-only GLM model.

When the case default is text-only and the case allows images:

- Case analysis hands visual units (pages, images, video segments, dense looks) to the first approved pool profile that can see images and holds an image grant, such as GLM-5.3-Flash. Text units stay on the default.
- If no such profile exists, visual units wait with the reason `vision_model_required: ...`. They re-queue once one is added.
- Chat on GLM-5.3 is told that it is text-only. For visual questions it delegates to a model that `list_agent_models` marks `allow_images`, or says that visual inspection needs an image-capable model.
- Settings shows the Z.ai key field and the two plan models with "Text only" or "Sees images" badges. The image grant checkbox is disabled for GLM-5.3, with an explanation.

## Verification

- Rust: provider unit tests (encoding, vision gating, streamed text and whole tool calls, policy and stream errors) and case-intelligence tests (no image tools for GLM-5.3, visual units routed to Flash, blocked with a reason when no vision model exists). The full suite passes with `--features subscription,research`.
- Frontend: `modelSeesImages`, model badges, and the Settings Z.ai group with its disabled image grant. 367/367 vitest; accessibility and harness-chat e2e 9/9.
- Synthetic end-to-end run: `scripts/native-case-index-run.ps1 -Provider zai` on a fresh copy of the sfd.ledcase test copy, debug build, loopback stand-in `scripts/native-zai-mock.mjs`. The stand-in checks every request's path, bearer key, model, thinking, max effort, `tool_choice`, and that images reach only an image-capable model.
  - Result: state `ready`, 223/230 units complete, 7 audio coverage notes, 0 blocked, 581 requests, 0 wire-check errors, 35.6 minutes.
  - All 1,061 images went to `glm-5.3-flash`; `glm-5.3` received none. Video, focus and page units ran on Flash. Transcript, text, audio inventory and synthesis units ran on GLM-5.3.
  - A follow-up chat question about visual content ran on GLM-5.3 with the text-only notice and no image tools offered, and completed.

## Not verified

- Real Z.ai responses. No Coding Plan key was available, so model behaviour, quota handling and the exact stream shape (for example, usage placement) were tested only against the documented protocol.
- Because Z.ai cannot force a tool, a real GLM model could answer a required visual-review step in plain text. The coordinator would then treat it as a failed step and the unit would retry or block. This has not been observed, because it needs a real model.
