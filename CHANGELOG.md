# Changelog

All notable public changes to WriteX are documented here.

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

