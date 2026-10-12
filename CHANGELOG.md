# Changelog

All notable changes to AskMate are listed here, newest first. The release workflow publishes the section for each tag as the GitHub release notes, so write each entry for people who use the plugin.

<!-- TODO(lead): the 1.12.0 section was written from the work package specs before the wave 2 merge. Check each bullet against the merged build, set the real release date, and keep the heading format "## [x.y.z] - YYYY-MM-DD": scripts/roadmap-smoke-tests.ts and release.yml both read it. Use absolute links in a release section, because relative links do not resolve in a GitHub release body. -->

## [1.12.0] - 2026-10-12

AskMate can now draw your notes as Mermaid diagrams, call tools through the Model Context Protocol (MCP) with your approval, and use reusable skills. It also has a guided first run, a new icon and a much safer write path.

### Added

- **Mermaid Diagram Studio.** Ask for a diagram in plain words, type `/diagram`, or press the Make a diagram chip. AskMate picks a diagram type that fits the note, checks the result against Obsidian's own Mermaid, repairs it once if it does not render, and otherwise shows the source and blocks Insert. Eight named looks (Blueprint, Sketchbook, Editorial Ink, Sunrise, Lagoon, Grape Soda, Slate and Terminal) use contrast-checked colours, and Another look draws it again in a different style. Diagram requests no longer go to paid image generation.
- **MCP tools.** Connect an MCP server over Streamable HTTP, or run a local server on desktop over stdio. MCP is off by default, each server must be trusted on each device before it starts, and AskMate asks before every tool call, showing the full arguments. Tool results are treated as untrusted text and never write to your vault. See [docs/mcp.md](https://github.com/CodeWithBehnam/askmate/blob/main/docs/mcp.md).
- **Skills.** Reusable instruction files in the Agent Skills `SKILL.md` format. AskMate ships a `mermaid-diagrams` skill, and you can add your own in a visible vault folder (`AskMate/Skills` by default). A vault skill stays inert until you review it. Use `/skill`, `/skills` or `@skill:name`. See [docs/skills.md](https://github.com/CodeWithBehnam/askmate/blob/main/docs/skills.md).
- **Tool calling for every provider.** OpenAI, Azure OpenAI, OpenRouter, Azure AI Foundry, Anthropic, Google Gemini and local OpenAI-compatible servers can all use MCP tools when the model supports them. Runs stop after a fixed number of rounds and calls.
- **Guided first run.** A fresh install opens the sidebar with a Connect card: choose a provider, paste a key, press Connect. AskMate tests the key and explains failures in plain language. Three starter chips follow: Summarise this note, Make a diagram and Find gaps. New commands `/setup`, `/welcome`, `/test`, `/mcp`, `/skills`, `/skill`, `/diagram` and `/images`.
- **New icon.** The Mate Mark appears in the ribbon, the sidebar header and menus.
- **Documentation.** A shorter README and a `docs/` folder with commands, workflows, providers, Apply, privacy, troubleshooting, skills, MCP and diagrams.
- **Repository checks.** `bun run lint` runs the Obsidian review rules, `bun run typecheck:tests` checks the tests, and CI runs both. Releases now use this changelog as their notes and fail if an asset is missing.

### Changed

- Fresh installs start in the Compact layout with the Connect card, and the translation language defaults to English. Existing installs keep their saved layout and language. Console is still available with `/layout console` or in settings.
- OpenAI, Anthropic, Google Gemini and OpenRouter always use the vendor's own address, so a changed address in `data.json` can no longer send your key to another host. To use a proxy or gateway, choose Local or self-hosted.
- More retired Claude model IDs (Claude 3.7 and the dated Claude 4 IDs) are switched to the current default automatically.
- Prompts follow the GPT-5.5 structure more closely, and the repeated rule blocks in each request are gone. Skill and tool text is escaped like note text.
- Settings carry a schema version, and AskMate keeps keys it does not recognise when a newer version wrote them.
- Longer output limits and timeouts for high-effort reasoning models and for Gemini 2.5 thinking.

### Fixed

- Retry now sends a new request, and uses the current model.
- Insert at cursor no longer writes unchecked model text or silently replaces your selection.
- Interrupted or truncated replies are no longer saved or announced as finished, and they keep the usage the provider already reported.
- Model replies, result notes, exports and the review queue go through the same sanitiser that protects the sidebar. Links to `obsidian://`, `file:` and script schemes are no longer clickable in replies.
- Several ways around the Mermaid remote-resource guard are closed, and legitimate diagrams are no longer downgraded to text.
- Apply keeps CRLF line endings, handles replies that start with a rule or frontmatter, places images and backlinks outside code fences, and shows long edits correctly in the preview.
- Saved conversations follow renamed and deleted notes, no longer reorder when you only look at them, stay within a size cap, and can no longer be revived by an open sidebar after you delete them. Two sidebars no longer overwrite each other.
- Synced devices no longer overwrite each other's threads, history and queue, and an unreadable `data.json` is kept as a backup.
- Budget guardrails count aborted and failed requests that were really sent.
- Context no longer attaches the same note up to three times, reports a missing folder instead of treating it as empty, and skips the raw data of Excalidraw notes.
- Layout fixes for narrow sidebars, wide images in replies, code colours in light themes and modal buttons.

### Security

- A stored secret name and base URL can no longer be combined to send a key to a different host.
- MCP servers need per-device trust, tool definitions are fingerprinted so a changed tool needs fresh approval, and tool descriptions and results are cleaned of hidden characters and treated as untrusted.
- Local MCP servers start with an argument list, no shell, and a minimal environment.

### Upgrade notes

- Skills, diagram and MCP settings are saved in `data.json` under their own keys, next to a `settingsVersion`. A device still on 1.11.1 drops keys it does not know when it saves, so update every device that syncs the same vault.
- MCP trust is stored on each device and does not sync. A synced server definition arrives untrusted.
- The minimum Obsidian version stays 1.13.0.

## [1.11.1] - 2026-10-12

### Fixed

- Plugin review warnings from the 1.11.0 scan: popout-window safe timers and requests, command names without the plugin name, and the destructive button style.

## [1.11.0] - 2026-10-12

### Added

- Streaming replies for every text provider, with a Stop button that cancels the request.
- Saved conversations with `/new`, `/threads`, `/rename`, `/delete-thread` and `/export`.
- Copy and Insert at cursor on every reply, `/model` and `/provider`, `@links`, `@backlinks`, `@tag:` and `@recent` mentions, an AskMate section in the editor menu, and custom instructions with per-folder rules.

### Fixed

- Render-safety bypasses that could load remote resources from a model reply.

## [1.10.1] - 2026-10-01

### Fixed

- The sidebar composer stays clear of Obsidian's floating status bar.

## [1.10.0] - 2026-10-01

### Changed

- Redesigned settings for clearer setup and editing.

## Earlier releases

Releases before 1.10.0 are listed on the [GitHub releases page](https://github.com/CodeWithBehnam/askmate/releases).
