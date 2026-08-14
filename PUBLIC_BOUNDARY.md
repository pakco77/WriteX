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

The ignore rules in `.gitignore` enforce the file-level exclusions inside this directory. A release must still run the boundary and secret checks in `RELEASING.md`; ignore rules are not a security control by themselves.

## Obsidian submission blocker

The compatibility manifest ID is currently `obsidian-agent`. Obsidian's current submission rules do not allow a plugin ID containing `obsidian`. This does not block publishing source on GitHub, but it blocks submission to the Community directory.

Do not change the ID in place without a tested migration. Obsidian would treat `writex` as a different plugin, so the migration must preserve or explicitly transfer the existing plugin's `data.json`, SecretStorage entries, folder state, and enablement expectations. The public ID decision and installed-data migration require a separate test-first release step.

## Open and closed product surfaces

The plugin source is licensed under AGPL-3.0-only. It remains useful with local Agents, local preview/copy, downloaded themes, and a user-owned self-hosted Relay that always consumes 0 WriteX credits.

Write Cloud is an optional proprietary hosted service. The public plugin includes only the client contract needed to make explicit requests. It must never silently replace a local Agent, a user-configured provider, or a self-hosted Relay.

## Brand boundary

The source license applies to code, not to the WriteX name, wordmark, or logo. See `TRADEMARKS.md`.
