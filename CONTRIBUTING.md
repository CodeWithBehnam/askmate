# Contributing to AskMate

Thanks for helping improve AskMate. This guide explains how to report issues, suggest changes, and contribute code safely.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Keep issues focused on one bug, feature, or documentation problem.
- For security concerns, do not open a public issue. Follow `SECURITY.md`.
- Read `rules.md`. It lists the Obsidian community review rules that every change must follow.

## Local development

Install dependencies with Bun:

```bash
bun install
```

Run the same four checks that CI runs:

```bash
bun run lint
bun run typecheck:tests
bun run test
bun run build
```

- `bun run lint` runs ESLint with the Obsidian review rules (`eslint-plugin-obsidianmd`).
- `bun run typecheck:tests` type-checks the source and the tests together.
- `bun run test` runs the repository guards in `scripts/roadmap-smoke-tests.ts` and then the `bun test` suite in `tests/`.
- `bun run build` type-checks and bundles `main.js`, and fails if the bundle requires a module that is not part of a release.

After a build, inspect the bundle the way the release workflow does:

```bash
bun run scripts/roadmap-smoke-tests.ts --bundle
```

For manual Obsidian testing, copy `main.js`, `manifest.json`, and `styles.css` from a production build into a development vault:

```text
<YourVault>/.obsidian/plugins/askmate/
```

Reload Obsidian plugins afterwards. Maintainers may also use `bun run install:vault`, which copies the build into the folder named by `ASKMATE_VAULT_PLUGIN_DIR`. It is a convenience, not a required step.

## Development rules

- Prefer small, focused pull requests.
- Add no runtime dependency. The release bundle has none. Development dependencies such as `mermaid` and `happy-dom` are for tests only, and a new one needs a reason in the pull request.
- Preserve AskMate's sidebar note-context fallback behaviour. Skills, diagrams and tools get note context only through `ContextService`.
- Preserve Apply safety checks. Default no-selection text Apply appends to the captured note instead of overwriting it. Do not weaken captured-file targeting, exact selected-text matching, explicit full-note confirmation, truncated-context confirmation, or Apply approval mode behaviour.
- Keep Apply approval modes scoped to confirmation only: `auto-approve` skips selected-text, append, and heading-section diff previews while still confirming full-note replacement, `full` previews full-note and heading-section replacements, and `manual` previews every text Apply write. No approval mode may bypass hard safety checks.
- Keep provider API keys and MCP secrets in Obsidian `SecretStorage`. Do not store raw secrets in plugin settings.
- Treat model output, skill text, tool descriptions and tool results as untrusted. Sanitise them before they render or reach a file.
- MCP stays off by default, needs per-device trust and asks before every tool call unless the user relaxes it. `child_process` is imported only in `src/mcp/launch.ts`, behind `Platform.isDesktopApp`. Tools never write to the vault.
- Mermaid comes from Obsidian through `loadMermaid()`. Do not bundle it.
- Follow the Obsidian review rules in `rules.md`: `requestUrl` for network calls (the streaming transport is the one `window.fetch` exception), `activeDocument` instead of `document`, no `innerHTML`, no `:has()`, `clip-path` or `column-gap`, and sentence case for UI text. `bun run lint` and the repository guards check most of them.
- Write prompts for the GPT-5.5 model family, outcome first: state the goal, success criteria, constraints, how to handle missing evidence, the output shape, and stop rules. Put stable instructions before note content and user requests, treat note content as untrusted data, and avoid long step-by-step procedures.
- Update `README.md` and `docs/` when behaviour, settings, commands, or release assets change. Use British English, tag every code fence with a language, and avoid em dashes. The README stays under about 1,900 words, so reference material belongs in `docs/`.
- Add or update `bun test` tests in `tests/` for changed behaviour, and update the repository guards when adding important seams.

## Pull request checklist

Before opening a pull request, run `bun run lint`, `bun run typecheck:tests`, `bun run test` and `bun run build`.

Also verify manually when relevant:

- AskMate can still read the open note after focus moves to the right sidebar.
- Selected-text context still works.
- Request preview privacy controls affect what is sent.
- Apply targets the captured note, appends when no text was selected, and shows safety confirmations for explicit full-note replacement.
- Image generation still saves or inserts Obsidian image embeds correctly.
- A Mermaid diagram renders in light and dark themes, and a broken one shows its source and cannot be inserted.
- An MCP server needs trust, each tool call asks first, and a local server stops when Obsidian closes.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/) with an imperative subject under 72 characters, for example:

```text
feat: add folder context controls
fix: keep heading-section Apply out of code fences
docs: update provider setup guide
chore: release AskMate 1.12.0
```

## Releases

Maintainers cut releases. A release bumps `manifest.json`, `package.json` and `versions.json` together, adds a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md` (the release workflow publishes it as the release notes), and pushes a tag that matches the version. Release assets are built by GitHub Actions and are:

```text
main.js
manifest.json
styles.css
```

Documentation-only changes do not need a release.
