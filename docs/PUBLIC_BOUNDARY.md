# WriteX public repository boundary

This directory is the public repository root for the WriteX Obsidian plugin. The surrounding private workspace is not part of the repository.

## Included in the source repository

- `src/`: the desktop Obsidian plugin, local Agent adapters, image and theme handling, clipboard preflight, self-hosted Relay client, and Write Cloud client;
- `tests/`: public unit and contract tests that use synthetic data only;
- `scripts/`: reproducible build and theme-catalog verification tools;
- `docs/images/`: explicitly approved public screenshots or demonstrations;
- `manifest.json`, `versions.json`, package/build configuration, README, changelog, and public policy files.

## Excluded from the source repository

- the proprietary Write Cloud service source, database, encryption keys, deployment files, host configuration, logs, backups, and production evidence;
- the Write Relay server source until it has its own separately reviewed public boundary;
- the separately licensed `writex-theme-packs` repository and its source references;
- the parent workspace's `00_Context`, `20_Docs`, `60_Run-Release`, and `90_History` directories;
- installed plugin files, Obsidian Vault notes, `data.json`, SecretStorage values, Agent sessions, user feedback, image caches, and generated `.writex` state;
- real-account, real-article, cross-repository, and production acceptance tests;
- `main.js` and source maps. `main.js`, `manifest.json`, and `styles.css` are release assets; only the latter two remain tracked as source/configuration files.

The ignore rules in the repository root enforce the file-level exclusions inside this directory. A release must still run the boundary and secret checks in [`RELEASING.md`](RELEASING.md); ignore rules are not a security control by themselves.

## Legacy plugin migration

The public manifest ID is `writex`. The pre-public compatibility ID was `obsidian-agent`, which Obsidian treats as a different plugin.

On the first `writex` start, the plugin imports `obsidian-agent/data.json` only when the new plugin has no data file of its own. It writes the migrated copy to the new plugin directory and never deletes or rewrites the legacy source. Vault-global SecretStorage IDs and the legacy workspace view type remain unchanged. If both plugin IDs are enabled, the new plugin refuses to load and instructs the user to disable the legacy plugin first.

Obsidian command IDs include the plugin ID. Custom hotkeys assigned to the legacy plugin therefore do not migrate automatically and must be rebound after the ID change. The current acceptance Vault has no such custom hotkeys; this does not prove the absence of hotkeys in other Vaults.

## Open and closed product surfaces

The plugin source is licensed under AGPL-3.0-only. It remains useful with local Agents, local preview/copy, downloaded themes, and a user-owned self-hosted Relay that always consumes 0 WriteX credits.

Write Cloud is an optional proprietary hosted service. The public plugin includes only the client contract needed to make explicit requests. It must never silently replace a local Agent, a user-configured provider, or a self-hosted Relay.

## Brand boundary

The source license applies to code, not to the WriteX name, wordmark, or logo. See [`TRADEMARKS.md`](TRADEMARKS.md).
