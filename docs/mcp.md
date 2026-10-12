# MCP tools

The Model Context Protocol (MCP) lets AskMate call tools that live outside Obsidian: search a database, read a ticket, fetch a page. AskMate is an MCP client for tools. Every call needs your approval by default, and AskMate never writes tool output into your vault.

MCP is off until you turn on `Allow tools`. Nothing starts or connects by default.

## What is supported

| | Supported in 1.12 |
| --- | --- |
| Tools | Yes |
| Streamable HTTP servers | Yes, with a bearer token or custom headers |
| Local servers over stdio | Yes, on desktop |
| Resources, prompts, sampling, elicitation, subscriptions | No. AskMate declares no client capabilities, so a server cannot ask for them. |
| OAuth sign-in | No. Use a static token. |
| The old HTTP+SSE transport | No. AskMate says so and asks for a Streamable HTTP address. |

AskMate speaks both protocol eras. It first asks a server what it supports (the 2026-07-28 revision) and falls back to the earlier handshake (2025-11-25, also accepting 2025-06-18 and 2025-03-26). A local server that only speaks the earlier handshake is recognised after a short wait. AskMate reads a remote reply by what it holds, so a server that labels JSON as an event stream, or the reverse, still works.

## Add a server

Open settings, go to `Skills and tools`, and turn on `Allow tools`. AskMate asks you to confirm. Then use the plus button beside `Tool servers` and choose one of:

- **Remote server:** a Streamable HTTP address, plus a bearer token or headers if the server needs them. The address must use `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so a server on another machine in your network needs HTTPS. The address cannot hold a username, password or `#fragment`; use a bearer token instead.
- **Local program** (desktop only): the command, its arguments (one per line) and any environment variables.
- **Import from JSON:** see below.

A new server starts switched off. Open it to see its `Server`, `Connection`, `Permissions` and `Tools` sections. AskMate keeps up to 50 servers.

Tokens, secret headers and secret environment values are saved with Obsidian SecretStorage under names such as `askmate-mcp-<server>-token`, never in `data.json`. A value whose name looks like a credential (a token, key or password) is stored as a secret even if you do not tick `Store this variable as a secret`.

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

Import shows every command that would be added and stores secret-looking values in SecretStorage. Imported servers arrive switched off and are never trusted automatically. Fields AskMate does not use (`cwd`, `envFile`, `autoApprove`, `alwaysAllow`, `timeout`) are reported and ignored.

## Trust a server

Press `Trust and test` on the server's page. Before AskMate starts a local server or contacts a remote one, you review the exact definition in a dialog: the command line and arguments, which environment variables are plain and which come from SecretStorage, or the address, the host that receives your requests, the header names and the bearer token's secret name. The dialog also warns about risky commands, such as a shell command string, and marks hidden characters such as `[U+200B]` so they cannot disguise a command or an address. Trust is stored on this device only. If the command, arguments, environment variables, address, headers or token reference change, the server returns to `Needs trust`. A definition synced from another computer arrives untrusted. `Revoke trust` forgets it and stops the server.

## Approve each call

When the model wants a tool, AskMate shows a card in the reply with the server, the tool and the full, untruncated JSON arguments. You choose:

- **Allow once.**
- **Allow for this chat.** Offered only when the server's `Approval` setting reuses it (below). Later calls of the same tool in the same conversation then run without asking. The choice is held in memory only and ends when you leave, clear or delete the conversation.
- **Deny.** Stopping the run also denies.

Each server has an `Approval` setting in the `Permissions` group on its page:

| Choice | Behaviour |
| --- | --- |
| `Ask before every call` (default) | Every call waits for you and nothing is remembered. The card offers only Allow once and Deny. |
| `Ask once for each tool in a chat` | Asks the first time each tool is used in a conversation, and the card offers Allow for this chat. After you choose it, later calls of that tool in the same conversation run without asking. A new conversation asks again. |
| `Ask unless the tool only reads` | Lets tools through that the server itself marks read-only, but only when `Believe the server's read-only labels` is on for that server. The mark is the server's claim and AskMate does not verify it. Every other tool still asks, and its card offers Allow for this chat. |

Each tool definition (name, description, input schema, annotations) is fingerprinted with SHA-256. If a server changes a tool you approved, the tool gets a `Changed` badge and needs a fresh approval. A run keeps the tool list it started with, and a call to a tool that changed mid-run is not made. On a server's page you can switch off individual tools, and they never reach the model.

## How tools are used

- Tools are offered on questions you ask in the sidebar in `Chat` output mode, when at least one trusted server is ready or waiting to start and the model supports tool calls. They are not used for diagrams, images, `Note` or `Apply` output, batch runs, or workflows started from the command palette or the editor menu. When the model cannot take tools, AskMate says so and answers without them.
- The model gets `Tool rounds per answer` rounds of tool calls (5 by default, from 1 to 12). A round is one model turn that asks for tools. After the last round it gets one more turn, without tools, to write the answer. An answer makes at most 12 calls in all, and a call past that is answered as not run. A result is cut at exactly `Longest tool result` characters (20,000 by default, from 1,000 to 200,000) before the model sees it, and a one-line note says it was cut. AskMate applies both settings as you set them. Both are in the `Tools` group on the `Skills and tools` page. A call that takes too long is stopped, and AskMate tells the model not to retry it.
- A tool result is plain text to the model, wrapped as untrusted data, never placed in its instructions. Any of the server's own secret values found in it are masked first. Images are dropped.
- With `Stream replies` on, a reply that uses tools streams as it is written. Text written before a tool call is cleared when the tool runs, so only the answer stays.
- If you Apply a reply that was written from tool results, AskMate always shows the diff, whatever your approval setting. Such a reply cannot be queued for later review.
- Stop cancels the run. A call that was stopped is not sent.
- A saved conversation keeps only the server, the tool name, the outcome and a short summary of each call, never its arguments or result.

## What a server can see and do

A remote server receives the tool name and the arguments of calls you approve, and nothing else from AskMate. A local server is a child process that runs with your user's permissions: it can read and write any file your account can, including your vault, and use the network. Obsidian cannot sandbox it. Only add commands you would run in a terminal.

AskMate runs a local server without a shell, with an argument list and a short environment: a fixed list of standard variables (such as `PATH`, `HOME`, temporary folders and proxy settings) plus the ones you set. On Windows, `npx`, `uvx` and similar run through `cmd.exe`, and arguments containing `& | < > ^ % !` or quotes are refused. Point the command at `node.exe` and the script instead. A server starts the first time a run needs it and stops when you switch it off or close Obsidian: AskMate closes its input, then asks it to end, then ends it together with the processes it started.

When Obsidian was started from the Dock or Start menu, its `PATH` is shorter than your terminal's. On macOS and Linux AskMate reads your login shell's `PATH` once with a fixed command, and also looks in the usual install folders.

Tool descriptions and the descriptions inside input schemas are cleaned of control, zero-width and bidirectional characters and cut to 1,024 characters before the model sees them, and AskMate warns on text that looks like a hidden instruction. The approval card shows the original description with hidden characters made visible. These checks are heuristics. They do not replace your approval.

## Check status

`/mcp` in the sidebar lists servers and their status: off, needs your trust, ready (starts when first used), connecting, ready with the number of tools, needs sign-in (a missing or rejected token) or an error. A server's page shows the same states as a chip: `Off`, `Needs trust`, `Not started`, `Connecting`, `Ready`, `Needs a token` and `Error`. A failed server is left alone for 15 seconds so a missing command does not slow every question. See [troubleshooting](troubleshooting.md).

## Network and privacy

See [privacy](privacy.md) for the full disclosure of network use, child processes and what is stored.
