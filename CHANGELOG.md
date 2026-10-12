# Changelog

All notable changes to AskMate are listed here, newest first. The release workflow publishes the section for each tag as the GitHub release notes, so write each entry for people who use the plugin.

## [1.12.0] - 2026-10-12

AskMate can now draw your notes as Mermaid diagrams, call tools through the Model Context Protocol (MCP) with your approval, and use reusable skills. It also has a guided first run, six regrouped settings pages, a new icon and a much safer write path.

### Added

- **Mermaid Diagram Studio.** Ask for a diagram in plain words, type `/diagram`, press the Make a diagram chip, or run the `Draw a diagram of the current note` command. AskMate picks the type that fits the note from 24 diagram types, checks the result against Obsidian's own Mermaid, repairs it once if it does not render, and otherwise shows the source and blocks Insert and New note. Eight named looks (Blueprint, Sketchbook, Editorial Ink, Sunrise, Lagoon, Grape Soda, Slate and Terminal) use contrast-checked colours, and Another look moves on to the next one. Diagram requests no longer go to paid image generation. Four diagram settings sit on the Skills and tools page.
- **MCP tools.** Connect an MCP server over Streamable HTTP, or run a local server on desktop over stdio. MCP is off by default (`Allow tools`), each server must be trusted on each device before it starts, and AskMate asks before every tool call, showing the full arguments, unless you choose Allow for this chat or relax a server's approval setting. You can import `mcpServers` JSON from Claude Desktop, Cursor, VS Code, Claude Code or Cline, switch off single tools, and check status with `/mcp`. Tool results are treated as untrusted text, and AskMate never writes tool output to your vault. See [docs/mcp.md](https://github.com/CodeWithBehnam/askmate/blob/main/docs/mcp.md).
- **Skills.** Reusable instruction files in the Agent Skills `SKILL.md` format. AskMate ships a `mermaid-diagrams` skill, and you can add your own in a visible vault folder (`AskMate/Skills` by default), start from `New skill from template` or install five examples. A vault skill stays inert until you review it. Use `/skill`, `/skills`, `@skill:name`, the skill picker or a suggested chip. `When to use a skill` chooses between off, suggestions only and automatic use of built-in or approved skills. See [docs/skills.md](https://github.com/CodeWithBehnam/askmate/blob/main/docs/skills.md).
- **Tool calling for every provider.** OpenAI, Azure OpenAI, OpenRouter, Azure AI Foundry, Anthropic, Google Gemini and local OpenAI-compatible servers can all use MCP tools when the model supports them. An answer makes at most 12 tool calls in at most 7 rounds, and a tool result is cut before the model sees it.
- **Guided first run.** A fresh install shows a notice with a Set up button and opens the sidebar with a Connect card: choose a provider, paste a key, press Connect. AskMate tests the key and explains failures in plain language with one button to fix them. Three starter chips follow: Summarise this note, Make a diagram and Find gaps. New commands `/setup`, `/welcome`, `/test`, `/mcp`, `/skills`, `/skill`, `/diagram` and `/images`.
- **Command palette.** `Draw a diagram of the current note`, `New conversation`, `Open settings` and `Stop current run`. Only one palette or editor menu run goes at a time.
- **New icon and look.** The Mate Mark appears in the ribbon, the sidebar header and menus. Its indigo and mint accents sit on top of your Obsidian theme and never replace its colours.
- **Safer imports and larger requests.** AskMate asks before importing a workflow preset whose prompt or template contains a link, an image or a template tag, and imports a preset that does not say what it produces as New content. It always asks before sending a request estimated at 150,000 input tokens or more.
- **Documentation and checks.** A shorter README and a `docs/` folder with commands, workflows, providers, Apply, privacy, troubleshooting, skills, MCP and diagrams. `bun run lint` runs the Obsidian review rules, `bun run typecheck:tests` checks the tests, and CI runs both. Releases use this changelog as their notes and fail if an asset is missing.

### Changed

- Settings are regrouped into six pages: Connection, Sidebar and output, Privacy and memory, Skills and tools, Instructions and Advanced. Connection shows what is still missing. A few settings have new names, such as `Remember conversations` and `Ask before changing my notes` (the Apply approval mode).
- Fresh installs start in the Compact layout with the Connect card, follow-up questions use earlier answers, usage guardrails warn about large requests, and the translation language follows your Obsidian interface language (English when that is English or unknown). Existing installs keep their saved layout and settings. Console is still available with `/layout console` or in settings.
- A Note or Apply output mode you choose now covers the next answer only, then AskMate goes back to Chat.
- OpenAI, Anthropic, Google Gemini and OpenRouter always use the vendor's own address, so a changed address in `data.json` can no longer send your key to another host. To use a proxy or gateway, choose Local or self-hosted. A stored key goes to an Azure AI Foundry or Local address that is not on your computer only after you approve that host on this device.
- More retired Claude model IDs (Claude 3.7, Sonnet 4, Opus 4 and Opus 4.1) are switched to the current default automatically.
- Prompts follow the GPT-5.5 structure more closely, and the repeated rule blocks in each request are gone. Skill and tool text is escaped like note text.
- Settings carry a schema version, and AskMate keeps keys it does not recognise when a newer version wrote them.
- Longer output limits for Claude and Gemini 2.5, and longer timeouts for OpenAI reasoning models at medium effort and above.
- A batch run stops after three notes in a row fail because the provider rejected the request or the usage guardrails blocked it, and it skips a note too large to send instead of stopping to ask.

### Fixed

- Retry rebuilds the request when you changed the model, provider or note since the failure, instead of sending the old one.
- Insert at cursor no longer writes unchecked model text or replaces your selection. A reply with active content offers a safe version, Insert anyway or Cancel.
- Interrupted or truncated replies are no longer saved or announced as finished, and they keep the usage the provider already reported.
- Model replies, result notes, exports and the review queue go through the same sanitiser that protects the sidebar. Links to `obsidian://`, `file:` and script schemes are no longer clickable in replies.
- Several ways around the Mermaid remote-resource guard are closed, and legitimate diagrams are no longer downgraded to text.
- Apply keeps CRLF line endings, handles replies that start with a rule or frontmatter, places images and backlinks outside code fences, and shows long edits correctly in the preview.
- Saved conversations follow renamed and deleted notes, no longer reorder when you only look at them, stay within a size cap, and can no longer be revived by an open sidebar after you delete them. Two sidebars no longer overwrite each other.
- Synced devices no longer overwrite each other's threads, history and queue, and an unreadable `data.json` is copied to `data.json.corrupt-` plus the time before AskMate starts with defaults.
- Budget guardrails count aborted and failed requests that were really sent.
- Context no longer attaches the same note up to three times, reports a missing folder instead of treating it as empty, and skips the raw data of Excalidraw notes.
- Layout fixes for narrow sidebars, wide images in replies, code colours in light themes and modal buttons.

### Security

- A stored secret name and base URL can no longer be combined to send a key to a different host.
- MCP servers need per-device trust, tool definitions are fingerprinted so a changed tool needs fresh approval, and tool descriptions and results are cleaned of hidden characters and treated as untrusted. Applying a reply that was written from tool results always shows the diff, and such a reply cannot be queued for later.
- Local MCP servers start with an argument list, no shell, and a minimal environment.
- Vault skills do nothing until you review the text and approve its hash.

### Upgrade notes

- Skills, diagram and MCP settings are saved in `data.json` under their own keys (`skills`, `diagrams` and `mcp`), next to a `settingsVersion`. A device still on 1.11.1 drops the keys it does not know, so its next save removes your skills, diagrams and MCP settings from the synced file. Update every device that syncs the same vault before you change those settings.
- MCP trust is stored on each device and does not sync. A synced server definition arrives untrusted, and API keys in SecretStorage stay on the device where you pasted them.
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
