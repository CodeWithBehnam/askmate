# Providers and models

AskMate has no account and no server. It calls the provider you choose with your own key, and the provider bills you under its own pricing. AskMate's usage budgets can warn or block oversized requests, but your provider's billing page is the authority on what you are charged.

## Supported providers

| Provider | Text | Images | Key | Notes |
| --- | --- | --- | --- | --- |
| OpenAI | Yes | Yes, `gpt-image-2` | Yes | Default model `gpt-5.5`. Text uses the Responses API with `store: false`. |
| Azure OpenAI | Yes | No | Yes | Base URL `https://<resource>.openai.azure.com/openai/v1`. Type your Azure deployment name as the model; deployments cannot be listed with a key, so there is no model refresh. |
| Azure AI Foundry | Yes | No | Yes | Inference endpoint such as `https://<resource>.services.ai.azure.com/models`. Enter the model or deployment name. Requests go to `/models/chat/completions?api-version=2024-05-01-preview`. |
| OpenRouter | Yes | No | Yes | OpenRouter model IDs through an OpenAI-compatible API. Default `openai/gpt-5.5`. |
| Anthropic Claude | Yes | No | Yes | Default `claude-sonnet-5-5`; `claude-opus-5-5` and `claude-haiku-4-5-20251001` are also offered. |
| Google Gemini | Yes | No | Yes | Default `gemini-2.5-pro`; `gemini-2.5-flash` is also offered. |
| Local or self-hosted | Yes | No | Optional | Any OpenAI-compatible server. Base URL such as `http://localhost:11434/v1`; AskMate adds `/chat/completions` itself, so do not paste the full path. |

Image generation always goes to the OpenAI Images API with `gpt-image-2`, whichever chat provider you use. It needs a paid OpenAI API account with access to that model, and OpenAI may require organisation verification. When your chat provider is not OpenAI, add an OpenAI key under `OpenAI image API key` in the `Images` group on the `Connection` page.

## Where to get a key

| Provider | Key page |
| --- | --- |
| OpenAI | https://platform.openai.com/api-keys |
| Anthropic | https://platform.claude.com/settings/keys |
| Google Gemini | https://aistudio.google.com/apikey |
| OpenRouter | https://openrouter.ai/settings/keys |
| Azure OpenAI and Azure AI Foundry | https://ai.azure.com/ |
| Local | No key. For Ollama, https://ollama.com/download |

## Connecting

The sidebar Connect card offers OpenAI, Anthropic, Gemini and Local. Choose one, paste the key and press `Connect`. The key is saved with Obsidian SecretStorage, and AskMate runs a connection test straight away. Failures are explained in plain language with one button for the next step, such as `Update key`, `Choose another model` or `Check the address`. Keys are stored per device, so paste the key again on each computer.

Other providers (Azure OpenAI, Azure AI Foundry, OpenRouter) are set up on the `Connection` settings page. Its `Status` row lists what is still missing. `Test connection` checks that the provider answers and lists the selected model; for Azure it sends a short request that may use a few tokens. The refresh button beside the model list (`Refresh models`) lists the models your key can use. If your model is not listed, turn on `Show more options` on the `Connection` page and type its ID under `Model ID`.

## Addresses

OpenAI, Anthropic, Google Gemini and OpenRouter always use the vendor's own address. A different address saved in `data.json` is reset, so a settings file from elsewhere cannot send your key to another host. To use a proxy or gateway, choose Local or self-hosted and set its address. For Azure OpenAI, Azure AI Foundry and Local or self-hosted addresses that are not on this computer, AskMate also asks you once per device to approve the host before it first sends the stored key there. Azure OpenAI is on that list because anyone can create a resource under an Azure domain. If you already use Azure OpenAI, you see the question on your first request after upgrading.

Remote addresses must use `https://`. Plain `http://` is accepted only when the traffic stays on your machine or network, because the key travels in a request header. These forms are accepted:

- Loopback: `localhost`, `127.0.0.0/8`, `::1` and names ending in `.localhost`.
- Private IPv4: `10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`.
- Link-local: `169.254.0.0/16` and IPv6 `fe80::/10`.
- Carrier-grade NAT: `100.64.0.0/10`, used by some VPNs and tailnets.
- IPv6 unique local addresses: `fc00::/7`.
- Single-label names such as `ollama` or `homeserver`.
- Names ending in `.local`, `.lan`, `.internal`, `.home`, `.home.arpa` or `.localdomain`.

An Azure OpenAI address must end with `/openai/v1`. A bare resource address is refused.

## Models

Anthropic model IDs that Anthropic has retired are switched to the current default automatically. That covers Claude 3, 3.5 and 3.7 models, Claude Sonnet 4, Opus 4 and Opus 4.1.

Reasoning effort (`none`, `low`, `medium`, `high`, `xhigh`) is checked against the model each time you switch. It is set with `/effort`, the composer, or `Reasoning effort` under `More options` on the `Connection` page (turn on `Show more options` first) for OpenAI. A text request waits up to two minutes for an answer by default. OpenAI reasoning models wait up to five minutes at medium effort and ten minutes at high or extra high effort. Anthropic waits up to five minutes between stream events, or ten minutes when streaming is off. `Refresh models` and the connection test give up after 10 seconds, except on Azure, whose test sends a real request and waits up to a minute.

## Tools

MCP tools work with OpenAI (Responses API), Azure OpenAI, OpenRouter, Azure AI Foundry, Anthropic, Google Gemini and local OpenAI-compatible servers, when the model supports tool calls. A model that does not is run without tools and AskMate says so. See [MCP tools](mcp.md).

## Local models

Choose Local or self-hosted, set the base URL (Ollama is `http://localhost:11434/v1`, LM Studio is `http://localhost:1234/v1`) and type a model name. No key is needed unless your server asks for one. Nothing leaves your machine except requests to that address.
