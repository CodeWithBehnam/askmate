# AskMate

**Labels:** AI notes, Q&A, summaries, rewrites, translation, workflows, safe Apply, image generation.

AskMate is a desktop-only Obsidian plugin that adds a right-sidebar AI assistant for the note you are reading or editing.

Use it to ask questions, summarize, rewrite, translate, run reusable workflows, generate images, and safely write AI output back into your vault.

## What It Does

- Uses selected text first, then falls back to the current or most recently active Markdown note.
- Works from the right sidebar without losing note context when the sidebar has focus.
- Supports OpenAI, OpenRouter, Anthropic Claude, Google Gemini, and local OpenAI-compatible text endpoints.
- Streams GPT-5.5 responses from OpenAI and supports provider-specific text responses elsewhere.
- Generates images with OpenAI `gpt-image-2`.
- Offers three output modes: Chat, New note, and Apply.
- Shows a local request preview before sending, including source, context size, provider, model, output mode, and privacy controls.
- Supports custom workflows, workflow variables, workflow import/export, and batch workflow runs across folders.
- Supports optional extra context from specific notes, folders, style guides, glossaries, Excalidraw text, image metadata, and note-specific AskMate history.
- Includes safer Apply previews, Markdown diffs, frontmatter handling, partial section Apply, and a review queue for suggested changes.
- Stores provider API keys through Obsidian `SecretStorage`.
- Does not include telemetry.

## Requirements

- Obsidian `1.11.4` or newer.
- Desktop Obsidian.
- An API key for your selected provider, unless your local endpoint does not require one.
- OpenAI API access for image generation with `gpt-image-2`.

## Installation

### From Obsidian Community Plugins

After AskMate is available in Obsidian Community Plugins:

1. Open Obsidian Settings.
2. Go to Community plugins.
3. Browse community plugins.
4. Search for `AskMate`.
5. Install and enable the plugin.

### Manual Installation

1. Download these files from the latest GitHub release:

```text
main.js
manifest.json
styles.css
```

2. Create this folder in your vault:

```text
YourVault/.obsidian/plugins/askmate/
```

3. Copy the three release files into that folder.
4. Restart Obsidian or reload plugins.
5. Enable AskMate from Community plugins.

## Quick Setup

1. Open AskMate settings in Obsidian.
2. Choose a chat provider: OpenAI, OpenRouter, Anthropic Claude, Google Gemini, or Local/self-hosted.
3. Add or select the provider API key secret.
4. For local endpoints, set the OpenAI-compatible base URL.
5. Click `Test API`.
6. Click `Refresh models`, or enter a model ID manually.
7. Choose your default text model.
8. Optional: configure image prompt planning and add an OpenAI key for `gpt-image-2`.
9. Optional: configure workflows, output templates, context budgets, send shortcut, usage budgets, and privacy defaults.

## Common Workflows

### Ask About A Note

1. Open a Markdown note.
2. Select text if you want to focus the question on a specific passage.
3. Open AskMate from the ribbon or command palette.
4. Ask a question, for example:

```text
What are the main claims in this note?
```

AskMate answers in the sidebar. By default, previous sidebar messages are shown for convenience but are not sent as chat history unless threaded chat is enabled.

### Create Or Apply Output

Choose an output mode before sending:

- `Chat`: show the answer in the sidebar.
- `New note`: create a Markdown result note.
- `Apply`: write generated text back into the captured source note after safety checks.

Apply mode can preview diffs, preserve or confirm frontmatter changes, replace selected text, replace a heading section, or queue a suggested change for later review.

### Generate Images

Use the Image button or start a request with `/image` or `/img`.

```text
/image Create a clean editorial illustration that captures the core idea of this note.
```

AskMate can save generated PNG files, create image result notes, or insert Obsidian image embeds depending on the selected output mode.

### Run Workflows

AskMate includes workflows for summaries, action plans, simple explanations, question drills, critiques, pros and cons, meeting notes, decision briefs, translation, quote extraction, rewriting, and more.

You can also create custom workflows in settings. Custom workflows can use variables such as:

```text
{{noteTitle}}
{{sourcePath}}
{{contextSource}}
{{selectedText}}
{{currentDate}}
{{currentDateTime}}
{{customInstructions}}
```

## Privacy And Network Use

AskMate sends data only when you run a request. Depending on your settings and request, that data can include your prompt, selected text, the current note, workflow instructions, opted-in extra context, image prompt planning content, or generated image prompts.

Image generation is sent to OpenAI because AskMate uses `gpt-image-2` for images. Text requests are sent to the provider you choose.

The prompt inspector is local. It lets you review the final prompt before sending and does not contact a provider by itself.

Provider API keys are stored through Obsidian `SecretStorage`. AskMate stores selected secret names, not raw keys. Generated notes, generated images, usage records, and plugin settings are stored locally in your vault or Obsidian plugin data.

Provider requests are subject to the selected provider's API terms and privacy policy.

## Roadmap

AskMate's current roadmap/status surfaces focus on making note work safer, clearer, and easier to review:

- evidence-linked answers for source-grounded replies and jump-to-source actions.
- Markdown diff Apply preview for safer note edits before writing changes.
- frontmatter controls for preserving, confirming, or replacing YAML during full-note Apply.
- batch workflow runner support for running workflows across folders.
- final prompt inspector tooling for reviewing the assembled prompt before sending.
- note-specific AskMate history for per-note follow-up context.
- style guide and glossary context roles for persistent writing and terminology guidance.
- Queue for review mode for AI-suggested changes that should be checked before applying.
- smart result-note placement for keeping generated notes near their source notes.
- Usage budgets and guardrails for warning or blocking oversized or over-budget requests.

## Troubleshooting

### AskMate used the wrong note

AskMate remembers the most recent Markdown note because the sidebar can take focus. If the preview points to the wrong note, click back into the intended note or select the exact text, then ask again.

### Apply cannot find selected text

AskMate only applies selected-text output when it can safely find the original selected text. Select the text again and use Apply from the assistant response.

### My model is not listed

Click `Refresh models` after adding or changing an API key. If the provider does not list the model you need, enter the model ID manually.

### Image generation fails

`gpt-image-2` may require OpenAI API access and organization verification. Check your OpenAI dashboard, then try again.

## Development

Install dependencies:

```bash
bun install
```

Run smoke tests:

```bash
bun run test
```

Build:

```bash
bun run build
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

## Contributing And Support

- Read `CONTRIBUTING.md` before opening a pull request.
- Use the issue templates for bug reports and feature requests.
- Report security concerns through `SECURITY.md`, not public issues.

## License

AskMate is released under the MIT License. See `LICENSE`.
