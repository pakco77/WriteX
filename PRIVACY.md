# Privacy

WriteX is a desktop Obsidian plugin. The native Markdown note remains the editing source of truth. This document separates local plugin behavior, third-party Agent behavior, self-hosted Relay behavior, and optional Write Cloud behavior.

## Data kept locally

WriteX may store the following in Obsidian plugin data or the Vault:

- per-note Chat messages, archived conversations, selected Agent/model metadata, and the Session ID required to continue a conversation;
- topics, local content-free feedback preferences, image provenance, theme state, and WeChat draft metadata;
- generated or imported image files and installed theme packages;
- non-secret settings such as executable paths, selected sync route, and service URLs.

Relay Keys, optional image API keys, and anonymous Write Cloud device credentials use Obsidian SecretStorage and are not written to ordinary `data.json`.

## Agent data flow

An Agent is contacted only after the user sends a message or explicitly requests an Agent operation. The selected Agent receives the current note context, selected text, user prompt, and any explicitly selected local Skill content required for that turn.

Codex, Claude, and WorkBuddy use their own local runtimes and account terms. Their CLIs may retain local sessions outside the Vault. WorkBuddy is configured as read-only by WriteX but may read permitted context in the Vault working directory; it is not a strict single-note sandbox.

## Network requests

Depending on user choices, WriteX may contact:

- the selected Agent provider through its local official runtime;
- fixed GitHub Release URLs for explicitly installed theme packages;
- a user-configured image API;
- a user-owned self-hosted Relay;
- the optional proprietary Write Cloud service.

WriteX has no client-side behavior telemetry. Local thumbs-up/down feedback records anonymous structural preferences and is not uploaded with article text.

## Self-hosted Relay

The self-hosted route sends confirmed article content and assets to the Relay chosen by the user. Relay credentials and Official Account secrets are controlled by that deployment. This route always consumes 0 WriteX credits.

## Write Cloud controlled test

Write Cloud is an optional proprietary hosted service. Starting the trial creates or restores an anonymous installation account. Before Official Account verification, the user explicitly submits the account name, AppID, and AppSecret; the service stores the secret encrypted at rest.

Before each draft sync, the plugin requests a quote without sending the title, body, or images. Only after final confirmation does it upload the confirmed article snapshot and required assets. The service stores account/installation/session identifiers, encrypted connection credentials, quote/job/credit records, cache metadata, and draft receipts needed to operate the test.

Version `0.5.2` does not yet expose self-service deletion of the Write Cloud installation/session or Official Account connection/AppSecret. For that reason Write Cloud remains a controlled test and is not ready for unrestricted directory onboarding. Local use and the self-hosted Relay do not depend on joining this test.

## Publication boundary

The public repository must not contain Vault notes, installed-plugin data, SecretStorage values, Agent sessions, real credentials, production databases, deployment configuration, or private acceptance evidence. See `PUBLIC_BOUNDARY.md`.

