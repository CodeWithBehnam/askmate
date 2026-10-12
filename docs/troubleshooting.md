# Troubleshooting

Start with `/test` in the sidebar or the `Test provider connection` command. It names the host it tried and the next step.

## Connecting

| What you see | Likely cause | Fix |
| --- | --- | --- |
| The provider rejected the key (401) | A wrong, expired or revoked key, or a key for another provider. | Press `Update key` and paste a fresh key from the provider's key page. See [providers](providers.md). |
| Access is forbidden (403) | The key is valid but the account or project cannot use that model. | Check the provider dashboard, or `Choose another model`. |
| Could not find the model or endpoint (404) | A misspelt model or deployment name, or the wrong address. | Refresh the model list, or type the exact ID. For Azure OpenAI, type the deployment name and end the address with `/openai/v1`. |
| Rate limit or quota (429) | The provider is throttling you or the account is out of credit. | Wait, or check billing with the provider. |
| Timed out | A slow reasoning model, a cold deployment or a bad connection. | Try again, lower the reasoning effort, or ask a shorter question. |
| Cannot reach a local server | Ollama or LM Studio is not running, or the address or port is wrong. | Start the server and press `Test connection`. Use `http://localhost:11434/v1` for Ollama. |
| The address must use https | A remote provider address was entered with `http://`. | Use `https://`, or a local network address. See [providers](providers.md) for the accepted forms. MCP server addresses are stricter, see [MCP tools](mcp.md). |
| My model is not listed | The list is cached from the last refresh. | Press `Refresh models` after adding a key, or type the model ID. |
| Image generation fails | `gpt-image-2` needs an OpenAI API account with access, and OpenAI may require organisation verification. | Check the OpenAI dashboard and try again. |
| AskMate asks for an OpenAI key when I press the Image button | Images are always made with OpenAI, so a chat provider such as Anthropic does not cover them. | Open the `Connection` page and pick a key under `OpenAI image API key`, in the `Images` group. |
| The key is missing on another computer | Keys are stored per device in Obsidian SecretStorage and do not sync. | Paste the key again on that computer. |
| A new host needs approval | A stored key is about to go to a Local, Azure OpenAI or Azure AI Foundry address it has not been sent to from this device. It also happens once on the first Azure OpenAI request after upgrading. | Check that the address is yours, then approve it. |

## Answers and context

| What you see | Likely cause | Fix |
| --- | --- | --- |
| AskMate used the wrong note | The sidebar took focus, so AskMate used the note it remembered. | Click back into the note, or select the exact text, then ask again. `/context` shows what will be sent. |
| The reply is marked incomplete | It hit the token limit, was filtered or the stream broke. | Ask for a shorter answer or raise the output limit. An incomplete reply is never used to replace text. |
| Streaming does not work | A local server, an Azure resource or a proxy refused the streaming request. | AskMate falls back to a single response. Turn off `Stream replies` if your endpoint handles streaming badly. |
| A skill was not used | It needs review, is switched off, `Use skills` is off (AskMate says so in a notice), or it does not match the request. | Run `/skills`, then name it with `/skill name` or `@skill:name`. See [skills](skills.md). |
| A skill shows Needs review | Its file is new or changed since you approved it. | Press `Review` beside it on the `Skills and tools` page and read the text before you approve. |
| AskMate drew a diagram when I did not ask for one | `Use built-in skills automatically` started the `mermaid-diagrams` skill because the request matched it. | Choose `Run again without skill` from the reply menu, or set `When to use a skill` to `Suggest one skill`. |

## Apply

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Apply cannot find the selected text | The note changed since the request, or the selection was lost. | Select the text again and Apply from the reply. With no selection, Apply appends to the captured note. |
| Apply refuses to replace | The reply is incomplete, the context was cut short, or note context was off for the request. | Append instead, or ask again with more context. See [apply](apply.md). |
| Apply stops to ask about active content | The reply holds something that stays active in a note, such as a remote image or a template tag. | The text AskMate writes is already the safe version. Read the warning, then confirm or cancel. |
| Insert at cursor does nothing | The note is in reading view. | Switch the note to editing mode. |

## Diagrams

| What you see | Likely cause | Fix |
| --- | --- | --- |
| The note shows Mermaid source, not a picture | Newer versions of Obsidian can ask once per vault whether to trust Mermaid diagrams. | Choose Trust when Obsidian asks. AskMate never changes that choice. |
| The card shows a fallback with the source | The diagram did not render, even after one repair. | Press `Fix` to try again, or edit the source. Insert and New note are blocked for that reply. |
| The diagram is too large to read | Dense notes make dense diagrams. | Ask for the part you care about, or ask for a simpler diagram. |

See [diagrams](diagrams.md).

## Tools (MCP)

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Tools are not offered | `Allow tools` is off, no server is ready, the output mode is not `Chat`, the request is a diagram, image or palette run, or the model does not support tool calls. | Turn on `Allow tools` on the `Skills and tools` page, trust the server, switch to `Chat`, or choose another model. `/mcp` shows status. |
| A server needs trust | It is new on this device, or its command, arguments, environment, address or headers changed. | Open the server in settings, review the exact command and press `Trust and test`. |
| Command not found (`npx`, `uvx`, `node`) | Obsidian was started from the Dock or Start menu and has a shorter `PATH` than your terminal. | AskMate also looks in the usual install folders. If it still fails, enter the full path to the program. |
| A tool shows a Changed badge | The server changed that tool's definition since you approved it. | Read the new description and arguments before you allow it. |
| A tool asks again on every call | The server's `Approval` setting is `Ask before every call` (the default). It asks every time, remembers nothing and offers only Allow once and Deny. | If you want Allow for this chat to cover later calls of the same tool, set `Approval` to `Ask once for each tool in a chat` on the server's page. |
| The answer stopped before the tool finished its job | The answer used up `Tool rounds per answer` or reached 12 tool calls, so the model wrote its reply from what it had, or a result was cut at `Longest tool result`. | Raise the limit on the `Skills and tools` page, under `Tools`, or ask a narrower question. |
| A remote server fails | The address, token or protocol is wrong. The old HTTP+SSE transport is not supported. | Use the server's Streamable HTTP address and check the bearer token. |
| A server says Needs a token | It answered 401, so the token is missing or no longer accepted. | Save a fresh bearer token on the server's page. |
| The server address is refused (`Use an https:// URL`) | It uses `http://` for a host other than `localhost`, or it holds a username, password or `#fragment`. | Use `https://`, or `http://` with `localhost`, `127.0.0.1` or `[::1]` only. Move credentials into a bearer token. |

See [MCP tools](mcp.md).

## Other

| What you see | Likely cause | Fix |
| --- | --- | --- |
| Settings look different on another device | A device still on 1.11.1 dropped keys it does not know when it saved. | Update every device that syncs the vault, then reconnect. |
| Layout is not what you expect | Layout is saved per vault. | `/layout compact`, `/layout expanded` or `/layout console`. |
| A conversation I deleted came back | Plugin data syncs between your devices, and a device that still holds the conversation, a note history entry or a queued review puts it back. | Delete it on every device that syncs the vault. |
| AskMate said it cut saved conversations | A load found more than the limits allow: 50 threads, 200 messages in a thread, 2 MiB in all, or a reply over 50,000 characters. The oldest were dropped. | The notice names a copy called `data.json.before-trim-` followed by a UTC time in the plugin folder. Open it to recover what you need. |
| AskMate could not read its saved settings | `data.json` was damaged. AskMate started with defaults. | The notice names a copy called `data.json.corrupt-` followed by a UTC time in the plugin folder. Open it to recover what you need. |

If you still need help, open an issue with your AskMate and Obsidian versions and your provider. Remove API keys and private note text first.
