# Contributing to WriteX

WriteX welcomes focused fixes and small improvements that preserve its product and safety boundaries.

## Before changing code

1. Keep the Obsidian native Markdown editor as the article source of truth.
2. Reuse an existing helper or platform API before adding a dependency or abstraction.
3. Add one focused regression test before fixing non-trivial behavior.
4. Use synthetic notes, credentials, images, account names, and server responses.

## Development

```bash
npm install
npm run check
```

The public test suite contains no real Vault fixtures, account credentials, or Write Cloud service source. Cross-repository and production acceptance remain private operational checks.

## Non-negotiable boundaries

- no automatic publish, mass send, or edit-triggered remote sync;
- no silent Agent, cloud, paid-provider, or lossy-image fallback;
- no real credential, private note, local absolute path, or production response in a commit or issue;
- no change that makes the self-hosted Relay consume WriteX credits;
- no external mutation without a visible action-time confirmation;
- no third-party theme or asset without source, author, license, and attribution review.

## Pull requests

Explain the user problem, the smallest change, the trust boundary touched, and the verification performed. Separate local tests from real external behavior. A passing build is not proof of an Agent, Relay, Write Cloud, or WeChat outcome.

By submitting a contribution, you confirm that you have the right to contribute it and agree to license it under this repository's AGPL-3.0-only license.
