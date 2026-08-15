# Releasing WriteX

This checklist prepares a release; it does not authorize a GitHub push or an Obsidian submission.

## Source boundary

1. Confirm the repository root is this plugin directory, not the parent private workspace.
2. Review `docs/PUBLIC_BOUNDARY.md` and `.gitignore`.
3. Confirm no ignored private acceptance test or runtime file is staged.
4. Search the candidate snapshot for credentials, private keys, bearer tokens, real account identifiers, private notes, absolute user paths, production IPs, and deployment configuration.
5. Verify `LICENSE`, `NOTICE.md`, `docs/TRADEMARKS.md`, `.github/SECURITY.md`, `docs/PRIVACY.md`, and `.github/CONTRIBUTING.md` are present.

## Quality gate

```bash
npm ci
npm run check
```

Then inspect the minified production `main.js`, but do not commit it to the source branch.

## Version gate

1. Confirm the manifest/package ID is `writex`, then run the legacy `obsidian-agent` data/SecretStorage migration tests and an isolated old-install upgrade rehearsal.
2. Keep `package.json`, `manifest.json`, `versions.json`, changelog, and tag version aligned.
3. Use a semantic version in `x.y.z` format.
4. Confirm `minAppVersion` matches the corresponding `versions.json` entry.
5. Confirm the migration notes tell legacy users to rebind any custom hotkeys; command IDs are not migrated with `data.json` or SecretStorage.

## Release assets

Attach exactly these files to the GitHub Release for the matching tag:

- `main.js`
- `manifest.json`
- `styles.css`

Verify downloaded release hashes against the local build before any Obsidian directory submission.

## External-action gate

Creating a repository, pushing source, publishing a Release, enabling GitHub Private Vulnerability Reporting, or submitting to the Obsidian community directory each requires explicit action-time confirmation.
