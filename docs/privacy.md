# Privacy and data

AskMate has no server and no account, and it collects no telemetry. It talks only to the services you configure. This page is the full disclosure that Obsidian asks every plugin to make.

## At a glance

| Area | What AskMate does |
| --- | --- |
| Network | Calls your chosen AI provider, any MCP server you add, and nothing else. No analytics, no update checks of its own. |
| Notes it reads | The selection or the current note by default. Other notes only when you mention them or turn on a context source. |
| Notes it writes | Only after you choose Apply, New note, Insert or a result note, through the checks in [apply](apply.md). MCP tools never write to your vault. |
| Clipboard | Write only. `Copy` puts a reply on the clipboard. AskMate never reads the clipboard. |
| Secrets | API keys and MCP tokens live in Obsidian SecretStorage. Settings hold the secret's name, not its value. |
| Local data | `data.json` in the plugin folder, described below. |
| Cost | The provider bills you directly. Image generation needs a paid OpenAI account. AskMate itself is free. |
| Child processes | Only if you add a local MCP server, and only on desktop. See below. |
| Files outside the vault | AskMate itself touches none. A local MCP server you run can. See below. |

## Network use

AskMate contacts these services and no others:

- Your AI provider: OpenAI, Azure OpenAI, Azure AI Foundry, OpenRouter, Anthropic, Google Gemini, or your local or self-hosted endpoint.
- Image generation always goes to the OpenAI Images API with `gpt-image-2`, even when another chat provider is selected.
- MCP servers you add. A remote server receives the tool name and arguments of calls you approve. A local server is a process on your computer.

It calls a provider only when you run a request, press `Test connection` or `Refresh models`, run the `Test provider connection` command, or approve an MCP tool call. Tests and refreshes send your key and no note content. For Azure OpenAI and Azure AI Foundry the test sends a minimal request that may use a few tokens.

A request can include your prompt, the selection or current note, workflow instructions, and any extra context you opted in to: other notes, folders, a style guide, a glossary, image metadata or note history, plus the text of any skill in use and the tool definitions of MCP servers you enabled.

Text requests use Obsidian's `requestUrl`. With `Stream replies` on, the streaming request uses the browser `fetch` so the reply can stream and Stop can cancel it. Both go only to the endpoints above. OpenAI text requests use the Responses API with `store: false`, so OpenAI is asked not to keep the response. Each provider's retention and abuse-monitoring policies still apply.

Remote provider addresses must use `https://`. Plain `http://` is accepted only for addresses that stay on your machine or network: loopback, private IPv4 ranges, link-local, carrier-grade NAT (`100.64.0.0/10`), IPv6 unique local and link-local, single-label names and `.local`, `.lan`, `.internal`, `.home`, `.home.arpa` and `.localdomain` names. The full list is in [providers](providers.md).

Mermaid diagrams are drawn by the copy of Mermaid that ships inside Obsidian. AskMate does not download Mermaid or any other code.

## What is stored

Everything below is in `data.json` inside your vault, at `.obsidian/plugins/askmate/` (the folder is whatever your vault's configuration folder is called). If you sync that folder with Obsidian Sync, iCloud or git, this data syncs with it.

- Note history: the question and answer of successful turns per note, up to 12 turns per note by default and 200 turns across all notes. Past the global cap, the oldest turns go first, whichever note they belong to. It is on by default; turn it off with `Store note-specific history`, or clear one note's history from the note history view. Sending that history with future requests is a separate switch and is off by default.
- Saved conversations: when `Save conversations` is on (the default), the full text of your questions and the replies, the model name, and the paths of related notes and saved images. Up to 50 threads of 200 messages each. Image data is not stored. Turn saving off, or use `Delete saved conversations`, to remove them.
- The review queue: pending suggestions keep the proposed text until you apply or dismiss them, and full-note replacements keep a snapshot of the original. Applied and dismissed items keep only metadata.
- Usage statistics: per-request token counts, provider, model, title and note path, plus per-day totals. No note text. `Reset statistics` clears them.
- Skills and tools settings: which skills are on, the SHA-256 of each vault skill you approved, diagram defaults, and your MCP server definitions. Definitions hold commands, arguments and addresses. Secret values are not in `data.json`.
- Settings and a settings version. <!-- TODO(lead): PLG-08 says an unreadable data.json is backed up before the next save (WP-11). Add a sentence here if it shipped. -->

Generated notes and images are ordinary files in your vault.

Trust for MCP servers is stored on each device, in Obsidian's local storage, and is not synced. A synced server definition therefore arrives untrusted.

## Secrets

API keys, MCP bearer tokens, custom header values and secret environment values are stored with Obsidian SecretStorage under generated names such as `askmate-openai-key` and `askmate-mcp-<server>`. AskMate stores the names and drops any plain-text key found in an older settings file when it saves. OpenAI, Anthropic, Google Gemini and OpenRouter keys can only go to the vendor's own address. An MCP secret is sent only to the host or process you trusted. Provider errors are redacted before they are shown or stored.

## MCP servers and child processes

MCP is off until you turn it on, and nothing starts or connects by default.

- A remote server is contacted over HTTPS with the bearer token or headers you set. Plain HTTP is accepted only for `localhost`, `127.0.0.1` and `[::1]`, which is stricter than the rule for provider addresses above. It sees the arguments of tool calls you approve. AskMate cannot see what it does with them.
- A local server is a child process: AskMate runs the command you entered, on desktop only, with your user's permissions. That process can read and write files anywhere your account can, and make its own network connections. Obsidian cannot sandbox it, so add only commands you trust.
- AskMate starts a server only after you trust that exact definition on this device, only when a run first needs it, and stops it when you turn it off or close Obsidian. It uses an argument list with no shell, and passes a short list of environment variables plus the ones you add.
- To find programs such as `npx` when Obsidian was started from the Dock or Start menu, AskMate runs your login shell once to read `PATH`, using a fixed command. This happens only when a local server is used.
- Every tool call needs your approval by default and shows the full arguments. Tool descriptions and results are untrusted text. See [MCP tools](mcp.md).

## Rendering safety

Model replies, skill text and tool output are untrusted. The sidebar and every write path sanitise them as described in [apply](apply.md). Notes, attachments, evidence excerpts, history, skills and tool results are wrapped in delimiter tags in the prompt, AskMate's own tags are escaped inside them, and the prompt tells the model not to follow instructions found there. This reduces prompt-injection risk. It is not a guarantee: a model can still be influenced by what it reads.

Context image previews load only vault images and embedded `data:` images, never remote addresses.

## Reporting a problem

Report vulnerabilities privately. See [SECURITY.md](../SECURITY.md).
