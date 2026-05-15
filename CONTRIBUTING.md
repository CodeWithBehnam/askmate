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

Smoke tests:

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
- Preserve Apply safety checks. Default no-selection text Apply appends to the captured note instead of overwriting it. Do not weaken captured-file targeting, exact selected-text matching, explicit full-note confirmation, truncated-context confirmation, or Apply preview behavior.
- Keep provider API keys in Obsidian `SecretStorage`. Do not store raw API keys in plugin settings.
- Make prompt changes outcome-first and compatible with the GPT-5.5 prompt guidance documented in `AGENTS.md`.
- Update `README.md` when behavior, settings, commands, or release assets change.
- Update smoke tests when adding important seams or roadmap behavior.

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

Use clear, imperative commit messages, for example:

```text
Add folder context controls
Fix Apply heading replacement safety
Update provider setup docs
```

## Release Assets

Manual/community plugin release assets are:

```text
main.js
manifest.json
styles.css
```

Run a production build before publishing release assets.
