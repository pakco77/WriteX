# Security policy

## Supported version

Security fixes currently target the latest `0.5.x` release. Older development snapshots are not supported.

## Reporting a vulnerability

Please use GitHub Private Vulnerability Reporting in this repository's **Security** tab after the repository is published. Do not open a public issue for a vulnerability that may expose credentials, private note content, arbitrary file access, remote execution, confirmation bypass, credit loss, or a real Official Account.

Include only the minimum material needed to reproduce the problem:

- affected WriteX and Obsidian versions;
- operating system;
- the smallest reproduction using synthetic notes and credentials;
- expected and actual behavior;
- whether the issue crosses the Vault, Agent, Relay, Write Cloud, or WeChat boundary.

Do not send a real AppSecret, Relay Key, access token, installation token, private note, production database, or full Agent session log. Redact account identifiers and local absolute paths.

## Security boundaries

- WriteX is desktop-only and can launch user-selected local Agent executables.
- Agent turns receive current-note context. WorkBuddy can read permitted Vault context; it is read-only in WriteX but is not a strict single-file filesystem sandbox.
- Real WeChat mutations require an action-time confirmation in the plugin.
- Self-hosted Relay and Write Cloud are separate trust boundaries and never switch silently.
- Write Cloud is proprietary and is not covered by this repository's source review.

## Disclosure process

The maintainer will confirm receipt, reproduce with synthetic data, assess affected versions, and coordinate a fix and release before public discussion. No response-time or bounty commitment is made by this policy.

