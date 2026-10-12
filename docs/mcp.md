# MCP tools

The Model Context Protocol (MCP) lets AskMate call tools that live outside Obsidian: search a database, read a ticket, fetch a page. AskMate is an MCP client for tools. Every call needs your approval by default, and tools never write to your vault.

MCP is off until you turn it on. Nothing starts or connects by default.

## What is supported

| | Supported in 1.12 |
| --- | --- |
| Tools | Yes |
| Streamable HTTP servers | Yes, with a bearer token or custom headers |
| Local servers over stdio | Yes, on desktop |
| Resources, prompts, sampling, elicitation, subscriptions | No. AskMate declares no client capabilities, so a server cannot ask for them. |
| OAuth sign-in | No. Use a static token. |
| The old HTTP+SSE transport | No. AskMate says so and asks for a Streamable HTTP address. |

AskMate speaks both protocol eras. It first asks a server what it supports (the 2026-07-28 revision) and falls back to the earlier handshake (2025-11-25, also accepting 2025-06-18 and 2025-03-26).

## Add a server

Open settings, then skills and tools, and turn on MCP. Add a server as one of:

- **Remote URL:** a Streamable HTTP address, plus a bearer token or headers if the server needs them. The address must use `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so a server on another machine in your network needs HTTPS. The address cannot hold a username, password or `#fragment`; use a bearer token instead.
- **Local command (desktop only):** the command, its arguments and any environment variables.

<!-- TODO(lead): confirm the labels of the server editor (WP-12). -->

Tokens, secret headers and secret environment values are saved with Obsidian SecretStorage under names such as `askmate-mcp-<server>-token`, never in `data.json`.

You can also paste the `mcpServers` JSON that Claude Desktop, Cursor, VS Code, Claude Code or Cline use:

```json
{
  "mcpServers": {
    "tickets": {
      "command": "npx",
      "args": ["-y", "<server-package>"],
      "env": { "API_TOKEN": "<your token>" }
    },
    "search": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

Import shows every command that would be added and stores secret-looking values in SecretStorage. Imported servers are never trusted automatically. Fields AskMate does not use (`cwd`, `envFile`, `autoApprove`, `alwaysAllow`, `timeout`) are reported and ignored.

## Trust a server

Before AskMate starts a local server or contacts a remote one, you review the exact definition in a dialog: the command line and arguments, which environment variables are plain and which come from SecretStorage, or the host, the header names and the bearer token's secret name. Trust is stored on this device only. If the command, arguments, environment names, address or header names change, the server returns to Needs trust. A definition synced from another computer arrives untrusted.

## Approve each call

When the model wants a tool, AskMate shows a card with the server, the tool and the full, untruncated JSON arguments. You choose:

- **Allow once.**
- **Allow for this chat.** Lasts for the conversation, in memory only.
- **Deny.** Dismissing the card also denies.

Each server has an approval mode:

| Mode | Behaviour |
| --- | --- |
| Always ask (default) | Asks before every call. Choosing Allow for this chat on the card covers that tool for the rest of the chat. |
| Ask once per chat | Asks the first time each tool is used and labels the card as a first use. Allow for this chat covers the rest of the chat. |
| Trusted read-only | Lets tools through that the server itself marks read-only, but only for a server you marked as trusted for that. The mark is the server's claim and AskMate does not verify it. |

<!-- TODO(lead): in src/mcp/McpService.ts only chat grants are created, so Always ask and Ask once per chat currently behave almost the same. Decide whether to describe them differently or merge them in the UI. -->

Each tool definition (name, description, input schema, annotations) is fingerprinted with SHA-256. If a server changes a tool you approved, the tool gets a Changed badge and needs a fresh approval. A `tools/list_changed` notice is ignored until the current run ends. You can switch off individual tools, and they never reach the model.

## How tools are used

- Tools are offered in sidebar Chat mode when a server is ready and the model supports tool calls. They are off in batch and command-palette runs and in Apply and New note output modes unless you opt in for that run.
- A run stops after a set number of rounds (default 5, up to 12) and at most 12 calls. A result is cut at a character limit (default 20,000) before the model sees it. A call that takes too long is stopped, and AskMate tells the model not to retry it.
- A tool result is plain text to the model, wrapped as untrusted data, never placed in its instructions. Images are dropped.
- If a tool result leads to a note change, the change goes through the Apply diff, whatever your approval mode.
- Stop cancels the run. A call that was stopped is not sent.

<!-- TODO(lead): confirm the round and result limits users can set, and which caps the tool loop applies (src/providers/tools/loop.ts uses 8 turns, 12 calls and 12,000 characters per result by default). -->

## What a server can see and do

A remote server receives the tool name and the arguments of calls you approve, and nothing else from AskMate. A local server is a child process that runs with your user's permissions: it can read and write files outside the vault and use the network. Obsidian cannot sandbox it. Only add commands you would run in a terminal.

AskMate runs a local server without a shell, with an argument list and a short environment (a few standard variables plus the ones you set). On Windows, `npx`, `uvx` and similar run through `cmd.exe`, and arguments containing `& | < > ^ % !` or quotes are refused. Point the command at `node.exe` and the script instead. A server starts the first time a run needs it and stops when you switch it off or close Obsidian: AskMate closes its input, then asks it to end, then ends it.

When Obsidian was started from the Dock or Start menu, its `PATH` is shorter than your terminal's. AskMate reads your login shell's `PATH` once with a fixed command, and also looks in the usual install folders.

Tool descriptions are cleaned of control, zero-width and bidirectional characters and cut to 1,024 characters before the model sees them, and AskMate warns on text that looks like a hidden instruction. The approval card shows the original description with hidden characters made visible. These checks are heuristics. They do not replace your approval.

## Check status

`/mcp` in the sidebar lists servers and their status: off, needs trust, idle (trusted and not started yet), connecting, ready (with the number of tools), needs authentication or error. A failed server is left alone for a short time so a missing command does not slow every question. See [troubleshooting](troubleshooting.md).

## Network and privacy

See [privacy](privacy.md) for the full disclosure of network use, child processes and what is stored.
