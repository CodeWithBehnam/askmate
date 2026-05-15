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
- Any behavior that could expose private note content unexpectedly.

## Response Expectations

The maintainer will triage reports as time permits. Valid reports should receive an initial response as soon as practical, with follow-up questions if more detail is needed.

Please give the maintainer reasonable time to investigate before public disclosure.
