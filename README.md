# AskMate

AskMate is a desktop-only Obsidian plugin that opens a right-sidebar AI panel for asking AI questions about the current note or selected text.

It is designed for note-focused Q&A, summarization, rewriting, translation, workflows, image generation, and safe note output inside Obsidian.

## Features

- Uses selected text as context when text is selected.
- Uses the current or most recently active Markdown note when no text is selected.
- Supports optional threaded chat mode for bounded follow-up context.
- Supports explicit multi-note context and bounded folder-level Markdown context.
- Sends text requests to OpenAI, OpenRouter, Anthropic Claude, Google Gemini, or an OpenAI-compatible local endpoint.
- Streams OpenAI GPT-5.5 text answers into the sidebar and supports other providers for text responses.
- Generates images with `gpt-image-2` through the OpenAI Images API.
- Lets you choose separate text providers for chat/workflows and image prompt planning. Image generation remains OpenAI `gpt-image-2`.
- Supports an Image button and `/image` or `/img` slash commands.
- Supports Chat, New note, and Apply output modes.
- Makes Apply safer by targeting the original request note and confirming full-note replacement.
- Shows a compact request preview with source, context size, provider, output mode, and per-request privacy controls.
- Lets you choose a concise, balanced, or expanded context budget before sending.
- Can add Excalidraw text summaries and image metadata manifests to context when enabled.
- Supports sidebar custom workflows created from settings.
- Imports and exports custom workflow presets as JSON.
- Supports workflow variables such as `{{noteTitle}}`, `{{selectedText}}`, `{{currentDate}}`, and `{{customInstructions}}`.
- Lets you favorite, hide, and reorder sidebar workflows.
- Shows an Apply preview before generated text is written into a note.
- Supports configurable Markdown templates for result notes, generated image notes, and per-custom-workflow result notes.
- Supports image folder and file-name templates for generated PNGs.
- Supports partial Apply actions for selected blocks and Markdown heading sections.
- Stores provider API keys through Obsidian `SecretStorage`.
- Lets you choose OpenAI reasoning effort for GPT-5.5 text requests.
- Lets you choose whether Enter or Ctrl/Cmd+Enter sends a message.
- Adds Obsidian commands that can be assigned hotkeys for opening AskMate, asking about a note, and generating an image.
- Supports compact and expanded composer layouts plus first-use onboarding tips.
- Shows referenced note images in chat only when the user asks to show or preview visual context.
- Tracks local usage statistics for AskMate operations.
- Includes workflow buttons for summary, planning, explanation, critique, translation, quotes, rewriting, and more.

## Requirements

- Obsidian `1.11.4` or newer.
- Desktop Obsidian. AskMate is marked desktop-only because it uses streaming network requests.
- An API key for your selected text provider, unless you use a local endpoint that does not require one.
- API access to the selected model. `gpt-image-2` image generation requires an OpenAI platform API key and may require OpenAI organization verification.

## Privacy And Network Use

AskMate does not include telemetry.

AskMate sends data to the selected provider only when you run a request. Image generation requests are sent to OpenAI because images use `gpt-image-2`. Depending on the request, this can include:

- Your typed prompt.
- Selected text from the active note.
- The full current or remembered Markdown note when no text is selected.
- Workflow instructions selected in AskMate.
- Image generation prompts and prompt-planning requests.

AskMate stores plugin settings in Obsidian plugin data. Provider API keys are stored through Obsidian `SecretStorage`; AskMate stores the selected secret names, not the raw keys.

Generated notes, generated images, and usage statistics are stored locally in your vault or plugin data. Provider requests are subject to the selected provider's API terms and privacy policies.

## Installation

### Community plugin installation

After AskMate is accepted into Obsidian Community Plugins:

1. Open Obsidian Settings.
2. Go to Community plugins.
3. Browse community plugins.
4. Search for `AskMate`.
5. Install and enable the plugin.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create this folder in your vault:

```text
YourVault/.obsidian/plugins/askmate/
```

3. Copy the three downloaded files into that folder.
4. Restart Obsidian or reload plugins.
5. Enable AskMate in Community plugins.

## Setup

1. Open Obsidian Settings.
2. Go to Community plugins.
3. Open AskMate settings.
4. Choose a chat provider: OpenAI, OpenRouter, Anthropic Claude, Google Gemini, or Local or self-hosted.
5. Create or select the provider API key secret, unless your local endpoint does not need a key.
6. For local or self-hosted providers, set the OpenAI-compatible base URL.
7. Click `Test API` to confirm the provider works.
8. Click `Refresh models` to load visible models, or type a manual model ID.
9. Choose a default model.
10. Choose the image prompt planning provider, or leave it set to Same as chat provider.
11. If you use image generation, add an OpenAI API key for `gpt-image-2`.
12. Choose reasoning effort for OpenAI GPT-5.5 text requests.
13. Choose whether Enter or Ctrl/Cmd+Enter sends messages.
14. Optionally set result templates, image naming templates, and the composer layout.
15. Optionally set the translation target language for the Translate Preserve workflow.
16. Optionally add custom workflows and configure request privacy defaults.

## Provider Setup

AskMate supports these text providers:

- OpenAI, uses GPT-5.5 text models through the Responses API.
- OpenRouter, uses OpenAI-compatible chat completions with OpenRouter model IDs such as `openai/gpt-5.5`.
- Anthropic Claude, uses the Anthropic Messages API with models such as `claude-3-5-sonnet-latest`.
- Google Gemini, uses the Gemini generateContent API with models such as `gemini-2.5-pro`.
- Local or self-hosted, uses an OpenAI-compatible `/chat/completions` endpoint such as Ollama at `http://localhost:11434/v1`.

Image generation remains OpenAI-only in this release because it uses `gpt-image-2`. Image prompt planning is separate from chat: choose Same as chat provider, or pick OpenAI, OpenRouter, Anthropic Claude, Google Gemini, or a local OpenAI-compatible endpoint for planning.

## Text Chat Workflow

1. Open a Markdown note.
2. Optionally select text.
3. Open AskMate from the ribbon or command palette.
4. Type a question, for example:

```text
What are the main claims in this note?
```

5. Click Send, or use the configured send shortcut.
6. AskMate streams the answer into the sidebar.

AskMate is note-first by default. Previous sidebar turns are displayed for convenience and are not sent unless you enable threaded chat mode in settings. When threaded mode is enabled, AskMate sends only the configured number of recent user and assistant turns as an extra context attachment.

Only one request can run at a time. Send, Image, workflow cards, output controls, reasoning controls, Clear, and vault-mutating assistant actions are guarded while a request is active. Stop cancels the active request.

The request preview shows the captured source, estimated primary context size, context budget, provider, model, output mode, and enabled extra context before sending. You can disable note context or image references for the next request from the preview controls. You can also add extra note paths or folder context per request from the Extra context panel.

## Image Generation Workflow

1. Open a Markdown note or select text to provide source context.
2. Type an image prompt, click the Image button, or start the prompt with `/image` or `/img`.
3. AskMate uses the configured image prompt planning provider to plan a JSON image prompt when possible.
4. AskMate sends the planned prompt to `gpt-image-2`.
5. In Chat mode, AskMate renders the generated image in the sidebar.
6. In New note mode, AskMate saves a PNG and creates a Markdown note with an Obsidian image embed.
7. In Apply mode, AskMate saves a PNG and inserts an Obsidian image embed into the captured note.

Example prompt:

```text
Create a clean editorial illustration that captures the core idea of this note.
```

If prompt planning fails, returns invalid JSON, or returns an empty prompt, AskMate uses a safe built-in prompt assembled from the request and note context.

## Extra Context

AskMate can include more than the active note when you opt in:

- Multi-note context, enter explicit Markdown paths or wikilinks in settings or the sidebar Extra context panel.
- Folder context, enable a specific folder path with max file and character limits. AskMate reads Markdown files in deterministic path order and skips hidden/plugin folders.
- Excalidraw summaries, extract readable text, labels, and embedded references from `.excalidraw` or `.excalidraw.md` files. This is text extraction, not pixel-level drawing analysis.
- Image manifests, include image paths, labels, extensions, file sizes, and reference metadata. This does not send image pixels to text providers.

All extra context is still subject to request privacy controls and the selected context budget.

## Context Image Preview

If the current note contains image links, AskMate can show thumbnails in chat when you explicitly ask to show or preview visual context, for example:

```text
show me the image in this note
```

Casual messages such as `hi` do not automatically show large context image previews.

## Note And Apply Output

AskMate has three output modes:

- Chat, show the answer in the sidebar.
- New note, create a Markdown note in the configured result folder.
- Apply, replace selected text or the captured note after safety checks.

In Apply mode, AskMate targets the note captured when the request was built. If full-note replacement is needed, AskMate asks for confirmation first.

When Apply preview is enabled, AskMate shows before and after size details and excerpts before writing generated text. Successful Apply and image insert operations include undo guidance.

Partial Apply actions are available on assistant replies:

- Apply reply, preserves the existing selected-text or full-note behavior.
- Apply selected block, requires the original request to use selected text.
- Apply to heading, asks for a Markdown heading title or full heading path such as `Project Plan > Risks`, refuses ambiguous headings, and replaces only that section body.

New note output uses configurable Markdown templates for text and image results. Custom workflows can override the global text result template with a per-workflow result note template. Generated PNGs use configurable folder and file-name templates, then AskMate adds a timestamp and resolves duplicate paths safely.

## Workflows

AskMate includes built-in workflows:

```text
Study Summary
Action Plan
Explain Simply
Question Drill
Buyer Protection Analysis
Knowledge Graph Links
Mermaid Diagram
Key Insights
Critical Review
Pros And Cons
Flashcards
Meeting Notes
Research Map
Decision Brief
Compare Ideas
Translate Preserve
Quote Extractor
Rewrite Polish
```

Workflow requests use the current note or selected text as context. Workflows require a text-capable provider model.

Custom workflows can be created from AskMate settings. They appear in the sidebar workflow panel. You can favorite, hide, and reorder sidebar workflows. Built-in workflows remain available from Obsidian's command palette.

Custom workflow presets can be exported to JSON and imported from JSON in settings. Imports append workflows and do not overwrite existing ones.

Workflow prompts support these variables:

```text
{{noteTitle}}
{{sourcePath}}
{{contextSource}}
{{selectedText}}
{{currentDate}}
{{currentDateTime}}
{{customInstructions}}
```

Use the workflow custom instructions setting to populate `{{customInstructions}}` across workflows. Each custom workflow can also define an optional result note template. Empty per-workflow templates fall back to the global result note template.

## Usage Statistics

The settings tab tracks local operation usage records for:

- Text responses through the selected provider.
- Image prompt planning through the configured planning provider when possible.
- Image generation through the Images API.

Token totals use provider-reported usage when available and local estimates otherwise. Images API rows may show zero tokens because image generation responses do not expose token usage in the same way.

## Troubleshooting

### AskMate used the wrong note context

AskMate remembers the most recent Markdown view and file because the right sidebar can take focus away from the active note. If the context icon points to an unexpected note, click back into the intended note or select the exact text, then ask again.

### Apply cannot find selected text

AskMate applies selected-text output only when it can find the original selected text safely. Select the text again and use the Apply action on the assistant response.

### Model not visible

Click `Refresh models` after adding or changing a provider API key. If a provider does not return the model you need, type the model ID manually in settings.

### Image model unavailable

`gpt-image-2` can require OpenAI organization verification. If image generation fails, verify API access in the OpenAI dashboard and try a GPT-5.5 text model for ordinary chat and workflows.

## Roadmap

AskMate is already useful today, but the goal is to keep making it more flexible, safer, and more powerful. This roadmap uses checkboxes so progress can be tracked directly in the repository.

### Provider support

- [x] Add a provider settings architecture so AskMate is not tied to a single API provider.
- [x] Add Google Gemini support.
- [x] Add OpenRouter support.
- [x] Add Anthropic Claude support.
- [x] Add local or self-hosted model support where practical.
- [x] Let users choose separate providers for chat and image prompt planning. Image generation remains OpenAI-only through `gpt-image-2`.
- [x] Add provider-specific setup documentation.

### Chat and context

- [x] Add an optional threaded chat mode that can include previous AskMate messages as context.
- [x] Add multi-note context selection.
- [x] Add folder-level context selection with clear token limits.
- [x] Add better Excalidraw context extraction and preview support.
- [x] Add smarter image understanding when a note includes images through image metadata manifests.
- [x] Add context budget controls so users can choose concise, balanced, or expanded context.

### Workflows

- [x] Let users create custom workflows from settings.
- [x] Let users reorder, hide, and favorite workflows.
- [x] Add import and export for workflow presets.
- [x] Add workflow variables for note title, selected text, current date, and custom instructions.
- [x] Add per-workflow result templates.

### Output and editing

- [x] Add safer Apply preview before applying generated text to a note.
- [x] Add partial apply options for headings, sections, and selected blocks.
- [x] Add undo guidance after Apply operations.
- [x] Add configurable result note templates.
- [x] Add better image result organization and naming.

### Privacy, safety, and reliability

- [x] Add a visible request preview that shows what note context will be sent.
- [x] Add per-request privacy controls for selected text, full note, and image references.
- [x] Add retry controls for failed API requests.
- [x] Add clearer error messages for provider authentication and quota issues.
- [x] Add smoke test coverage for prompt building seams, context capture seams, Apply safety guards, and usage tracking seams.

### User experience

- [x] Add Obsidian commands that users can bind to keyboard shortcuts for opening AskMate and running common actions.
- [x] Add more compact and expanded composer layouts.
- [x] Add general theme and focus polish for composer controls.
- [x] Add accessibility review for icons, labels, focus states, and keyboard navigation.
- [x] Add onboarding tips for first-time users.

## Development

Install dependencies:

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

Watch during development:

```bash
bun run dev
```

Release assets are:

```text
main.js
manifest.json
styles.css
```

## License

AskMate is released under the MIT License. See `LICENSE`.
