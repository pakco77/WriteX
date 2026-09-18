# Changelog

## 0.6.2 - 2026-09-18

- Install Vault Skills in Chat by pasting a GitHub repository URL; a single newly installed Skill is enabled automatically.
- Fixed Skill installs failing under Obsidian's restricted GUI PATH by resolving the Node binary directory before spawning `npx`.
- Added a per-theme usage guide in the theme library: each entry shows the Markdown syntax on the left and a real render from the current theme on the right.
- Added callout syntax for theme rendering: `> [!note]`, `> [!tip]`, `> [!warning]`, and `> [!quote]` produce note, tip, warning, and quote-card blocks; warning callouts share one unified amber treatment across themes, and callouts without a title no longer leave a blank label line.
- Tokenized all seven public themes (`{{tokens.*}}` placeholders with automatic derivation from template literals, render-byte-identical before and after) and added 2–3 official color palettes per theme with a palette dropdown in the theme library; the chosen palette persists per theme in plugin data.

## 0.6.1 - 2026-09-16

- Updated all bundled public themes to their capacity-safe packages. For the representative 3,561-character, 108-paragraph, 12-image article, every theme now stays below the WeChat draft 20,000-code-point and 1 MiB limits.
- Pinned the theme catalog to immutable `v0.6.1-themes.1` Release assets, including each package's version, byte length, and SHA-256.

## 0.6.0 - 2026-09-15

- Added a local account-positioning Markdown reference, independent topic-analysis Agent/model preference, explicit five-star analysis with detail and provenance, stale-rating status, rating filters, and user decisions/corrections.
- Preserved explicit Agent model choices outside a refreshed catalog; Codex reads its local app-server model list and WorkBuddy reads only CLI-advertised model values.
- Switched WorkBuddy no-tool writing-style extraction to its existing stream-json response path to avoid aggregate JSON output truncation.

## 0.5.9 - 2026-09-05

- Kept WeChat's 20,000-code-point and 1 MiB draft limits, added shared safe inline-CSS compression, accurate final-HTML metering, a previewable compact layout, and a direct rich-copy fallback for oversized drafts or animated GIFs.
- Added explicit topic-to-article association, confirmed native new-note creation, and reusable article opening without overwriting an existing Chat draft.
- Made outline flow use current local material plus bounded title-matched related notes, and added an opt-in Codex native web-search setting with actual completed-search disclosure.

## 0.5.8 - 2026-08-30

- Added one confirmed, Vault-local “我的文风” profile: explicit representative-work selection, per-note toggle, separate prompt context and compact message snapshot; export to a local Skill only after confirmation and never overwrite a manually changed export.
- Moved the local topic inbox into a reusable editor-tab page with created-time groups, local search, explicit target-note routing, and no automatic send or draft creation.
- Replaced direct selection replacement with a local before/after comparison modal and bounded text diff; only an explicit apply invokes the existing guarded editor replacement.
- Migrated persisted data from schema 5 to 6 without changing existing notes, topics, feedback, attachment, Relay, Cloud, or WeChat-cache records.

All notable public changes to WriteX are documented here.

## 0.5.7 - 2026-08-18

- Added GPT-style Chat attachments: choose files with the paperclip, drag them into the composer, or paste files from the clipboard.
- Added removable pending-attachment chips and attachment cards in the conversation history, including image thumbnails and honest missing-file states.
- Keeps attachments local to the current Vault and stages them only when sent; the writing prompt exposes only the files explicitly attached for that message.
- Passes explicitly attached, signature-validated images to Codex through native `--image` input while keeping the Chat turn read-only and bounded.
- Added attachment count, per-file, total-size, and empty-file validation before any Vault write.

## 0.5.6 - 2026-08-18

- Made blocking image errors actionable: the preflight identifies the article image number, source, and a preview or explicit unavailable-image fallback before any external draft action.
- Added a local gallery image check that marks unreadable, missing, or malformed images with a red border.
- Made CopyPlan show problematic images and safely exclude only unrecoverable images from the copied HTML without changing the Markdown note or original image files.

## 0.5.5 - 2026-08-15

- Removed the redundant plugin-name settings heading and use Obsidian's HTML sanitizer before appending validated theme previews.

## 0.5.4 - 2026-08-15

- Replaced directory-review-incompatible settings heading, HTML insertion, and textarea sizing shortcuts with Obsidian-supported UI APIs.
- Added an English README overview that states the native-note, Agent, and WeChat-drafts-only boundaries.

## 0.5.3 - 2026-08-15

- Changed the public Obsidian plugin ID and package name to `writex`.
- Added a one-time, copy-only migration from `obsidian-agent/data.json` when the new plugin has no data of its own.
- Preserved every established SecretStorage key and the legacy view type so credentials and workspace layout remain continuous.
- Refused to load the new plugin while the legacy plugin remains enabled, preventing two WriteX runtimes from owning the same views and data flow.
- Kept the legacy plugin directory and data untouched for recovery; no automatic deletion or enablement-file rewrite occurs.
- Added explicit Cloud credential-lifecycle controls: recoverable local disconnect, service-side current-device revocation, and connection/AppSecret deletion with clear destructive confirmation and no credential in a URL.
- Raised the minimum Obsidian version to `1.11.4`, the first version that exposes the SecretStorage API used during startup.
- Replaced the README's usage-heavy “30-second start” with a truthful 30-second installation path and a four-line product summary.
- Moved WorkBuddy/CodeBuddy setup guidance into the plugin's AI settings and organized repository policy documents under `.github/` and `docs/`.
- Added wide visual guides for the three-step installation path and four creator scenarios, with collapsed text alternatives retained for accessibility and search.
- Tightened the public hook to “AI 强化原创”, added a light real-UI overview of Obsidian + Chat, the image gallery and phone preview, and made the README's Agent, Skill, history, topic and WeChat delivery capabilities explicit.
- Passed the selected Vault Skill instruction into Codex image turns instead of only recording the Skill snapshot.

## 0.5.2 - 2026-08-15

- Added a resumable anonymous Write Cloud test route with a one-time 8-credit grant after the first eligible Official Account verification.
- Added explicit quote, reserve, settle, release, and unknown-result safeguards before draft synchronization.
- Made draft routing title-aware: body changes update the bound draft, while a changed synchronized title creates a new draft.
- Grouped settings into AI, Official Account, and Write Cloud sections; groups are closed by default.
- Enabled comments by default while retaining final user control.
- Completed real local WorkBuddy/CodeBuddy CLI new-session, resume, stop, and installed-UI response verification.
- Reworked the public README around original writing, a 30-second start, real use cases, data safety, and privacy boundaries.

## 0.5.1

- Preserved the self-hosted Relay as the default 0-credit route while preparing the optional hosted trial.

## 0.5.0

- Added the local topic library and creator-loop refinements.

## 0.4.0

- Added deterministic theme packages shared by preview, clipboard copy, and draft synchronization.

## 0.3.0

- Added separate Codex, Claude, and WorkBuddy Agent adapters, persisted conversations, local Skill selection, and safer image/copy handling.

## 0.2.0

- Added explicit create/update synchronization to a WeChat Official Account draft through a user-owned Relay.

## 0.1.0

- Added the native Obsidian writing workspace, Agent Chat, image gallery, phone preview, and rich copy.
