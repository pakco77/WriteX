# Notices and provenance

Copyright (C) 2026 Pakco.

WriteX plugin source is distributed under AGPL-3.0-only. See `LICENSE`.

## Product and code provenance

- The WriteX plugin implementation and logo in this repository are maintained by Pakco.
- WeSight was reviewed as a behavior and architecture reference. Its source code, comments, constants, types, and API wrappers are not included in this repository.
- Write Cloud is an optional proprietary hosted service. Its service source, deployment configuration, credentials, database, and production evidence are not included.
- The self-hosted Write Relay server is outside this plugin repository and requires its own release review.

## Theme packages

Downloadable themes are distributed separately from <https://github.com/pakco77/writex-theme-packs> with package-level source, author, license, modification, and checksum records. Six converted `gzh-design-skill` themes remain AGPL-3.0; the Cyberpunk conversion remains MIT. The plugin repository contains only the catalog metadata and validation/runtime code required to install them explicitly.

The built-in default and Xiaohei themes are original WriteX components covered by this repository's license.

## External products and marks

Obsidian, Codex, Claude, WorkBuddy, CodeBuddy, WeChat, GitHub, and other third-party names and marks belong to their respective owners. References describe compatibility or user-selected integrations and do not imply endorsement.

## Development dependencies

The plugin uses the Obsidian API and development tooling declared in `package-lock.json`. These packages retain their own licenses. Production bundling keeps `obsidian` and `electron` external.

