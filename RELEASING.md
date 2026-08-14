# Releasing WriteX

This checklist prepares a release; it does not authorize a GitHub push or an Obsidian submission.

## Source boundary

1. Confirm the repository root is this plugin directory, not the parent private workspace.
2. Review `PUBLIC_BOUNDARY.md` and `.gitignore`.
3. Confirm no ignored private acceptance test or runtime file is staged.
4. Search the candidate snapshot for credentials, private keys, bearer tokens, real account identifiers, private notes, absolute user paths, production IPs, and deployment configuration.
5. Verify `LICENSE`, `NOTICE.md`, `TRADEMARKS.md`, `SECURITY.md`, `PRIVACY.md`, and `CONTRIBUTING.md` are present.

## Quality gate

```bash
npm ci
npm run check
```

Then inspect the minified production `main.js`, but do not commit it to the source branch.

## Version gate

1. Before an Obsidian directory submission, replace the incompatible legacy ID `obsidian-agent` only through the separately tested `writex` data/SecretStorage migration path.
2. Keep `package.json`, `manifest.json`, `versions.json`, changelog, and tag version aligned.
3. Use a semantic version in `x.y.z` format.
4. Confirm `minAppVersion` matches the corresponding `versions.json` entry.

## Release assets

Attach exactly these files to the GitHub Release for the matching tag:

- `main.js`
- `manifest.json`
- `styles.css`

Verify downloaded release hashes against the local build before any Obsidian directory submission.

## External-action gate

Creating a repository, pushing source, publishing a Release, enabling GitHub Private Vulnerability Reporting, or submitting to the Obsidian community directory each requires explicit action-time confirmation.
