# Contributing to AskMate

Thanks for helping improve AskMate. This guide explains how to report issues, suggest changes, and contribute code safely.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- Keep issues focused on one bug, feature, or documentation problem.
- For security concerns, do not open a public issue. Follow `SECURITY.md`.

## Local Development

Requirements:

```bash
bun install
```

Build:

```bash
bun run build
```

Tests (the roadmap smoke script plus the `bun test` suite in `tests/`):

```bash
bun run test
```

Manual Obsidian testing:

```text
<YourVault>/.obsidian/plugins/askmate/
```

Copy `main.js`, `manifest.json`, and `styles.css` from a production build into that folder, then reload Obsidian plugins.

## Development Rules

- Prefer small, focused pull requests.
- Preserve AskMate's sidebar note-context fallback behavior.
- Preserve Apply safety checks. Default no-selection text Apply appends to the captured note instead of overwriting it. Do not weaken captured-file targeting, exact selected-text matching, explicit full-note confirmation, truncated-context confirmation, or Apply approval mode behavior.
- Keep Apply approval modes scoped to confirmation only: `auto-approve` skips selected-text, append, and heading-section diff previews while still confirming full-note replacement, `full` previews full-note and heading-section replacements, and `manual` previews every text Apply write. No approval mode may bypass hard safety checks.
- Keep provider API keys in Obsidian `SecretStorage`. Do not store raw API keys in plugin settings.
- Write prompts for the GPT-5.5 model family, outcome first: state the goal, success criteria, constraints, how to handle missing evidence, the output shape, and stop rules. Put stable instructions before note content and user requests, treat note content as untrusted data, and avoid long step-by-step procedures.
- Update `README.md` when behavior, settings, commands, or release assets change.
- Add or update `bun test` tests in `tests/` for changed behaviour, and update the smoke tests when adding important seams or roadmap behaviour.

## Pull Request Checklist

Before opening a pull request:

```bash
bun run test
bun run build
```

Also verify manually when relevant:

- AskMate can still read the open note after focus moves to the right sidebar.
- Selected-text context still works.
- Request preview privacy controls affect what is sent.
- Apply targets the captured note, appends when no text was selected, and shows safety confirmations for explicit full-note replacement.
- Image generation still saves or inserts Obsidian image embeds correctly.

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/) with an imperative subject under 72 characters, for example:

```text
feat: add folder context controls
fix: keep heading-section Apply out of code fences
docs: update provider setup guide
chore: release AskMate 1.7.0
```

## Release Assets

Manual/community plugin release assets are:

```text
main.js
manifest.json
styles.css
```

Run a production build before publishing release assets.
