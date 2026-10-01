# Security Policy

## Supported Versions

Security fixes are handled on the latest released version of AskMate.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | Best effort |

## Reporting a Vulnerability

Please do not report security vulnerabilities in public GitHub issues.

Report security concerns privately through GitHub's private vulnerability reporting if it is enabled for this repository. If it is not enabled, contact the repository owner from the GitHub profile and include enough detail to reproduce the issue.

Useful details include:

- Affected AskMate version or commit.
- Obsidian version and operating system.
- Steps to reproduce.
- Impact and any known workaround.
- Whether API keys, note content, generated files, or provider requests are involved.

## Scope

Security-sensitive areas include:

- Provider API key storage and retrieval.
- Request privacy controls and context capture.
- Apply and partial Apply write safety, including default append behavior and explicit full-note replacement gates.
- File path handling for generated notes and images.
- Import/export of workflow presets.
- Rendering of model replies in the sidebar.
- Prompt construction around untrusted note, attachment and evidence content.
- Provider base URL validation.
- Note history, review queue and usage data stored in the plugin's `data.json`.
- Any behavior that could expose private note content unexpectedly.

## Current Safeguards

These are the protections a report would bypass. They reduce risk; they are not guarantees.

- Model replies are untrusted. Before rendering a reply in the sidebar, AskMate turns remote Markdown images into links that are not loaded, shows HTML tags that would load network resources (such as `img`, `iframe`, `video`, `link` and `style`) as text, and relabels fenced code blocks whose language other plugins could execute (such as `dataviewjs`) so those processors do not run. Context image previews load only vault files and `data:image/` URIs.
- Note content is treated as untrusted data in prompts. Notes, attachments, evidence excerpts and history are wrapped in delimiter tags, AskMate's own delimiter tags are escaped inside that content, and the prompt tells the model not to follow instructions found there. This is prompt-injection hardening, not a guarantee: a model may still be influenced by note content.
- Provider base URLs must use `https://` for remote hosts. Plain `http://` is accepted only for localhost and private network addresses.
- AskMate refuses to use an incomplete or filtered reply to replace note text, and asks for confirmation before a replacement when the note or selection was truncated by the context budget.
- API keys are read through Obsidian `SecretStorage`; settings store only secret names, and provider error messages redact API keys.

## Response Expectations

The maintainer will triage reports as time permits. Valid reports should receive an initial response as soon as practical, with follow-up questions if more detail is needed.

Please give the maintainer reasonable time to investigate before public disclosure.
