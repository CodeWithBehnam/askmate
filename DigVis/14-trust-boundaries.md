# Trust Boundaries

## Purpose

Show security-relevant trust boundaries, user input, secrets, file access, network calls, external services, and permission checks.

## Diagram

```mermaid
flowchart TD
  User["User prompt and note content"] --> Sidebar["AskMate sidebar"]
  Sidebar --> Plugin["AskMatePlugin"]

  subgraph "User vault boundary"
    Notes["Markdown notes"]
    Images["Generated image files"]
    SettingsStore["Plugin settings data"]
  end

  subgraph "Obsidian protected APIs"
    SecretStorage["SecretStorage"]
    VaultAPI["Vault API"]
    RequestUrl["requestUrl"]
  end

  subgraph "External network boundary"
    OpenAI["OpenAI"]
    Azure["Azure providers"]
    OpenRouter["OpenRouter"]
    Anthropic["Anthropic"]
    Gemini["Google Gemini"]
    Local["Local OpenAI-compatible endpoint"]
  end

  Notes --> Plugin
  SettingsStore --> Plugin
  Plugin --> SecretStorage
  Plugin --> VaultAPI
  Plugin --> RequestUrl
  VaultAPI --> Notes
  VaultAPI --> Images
  RequestUrl --> OpenAI
  RequestUrl --> Azure
  RequestUrl --> OpenRouter
  RequestUrl --> Anthropic
  RequestUrl --> Gemini
  RequestUrl --> Local

  classDef user fill:#CCFBF1,stroke:#0F766E,color:#0F172A
  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0F172A
  classDef store fill:#FFEDD5,stroke:#EA580C,color:#7C2D12
  classDef external fill:#F3E8FF,stroke:#9333EA,color:#3B0764
  classDef risk fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D

  class User,Sidebar user
  class Plugin core
  class Notes,Images,SettingsStore,SecretStorage,VaultAPI store
  class RequestUrl,OpenAI,Azure,OpenRouter,Anthropic,Gemini,Local external
```

## What can cross boundaries

| Boundary | Data that may cross | Controls and safeguards |
| --- | --- | --- |
| Vault to prompt | Current note, selected text, attachments, image references if enabled. | Request privacy defaults, request preview, prompt inspector, context budget, image reference omission. |
| Settings to runtime | Provider choices, model IDs, context limits, output and Apply settings. | Defaults and normalizers. |
| Secret storage to provider call | API key retrieved by secret name. | Raw keys are retrieved from `SecretStorage`, not stored directly in settings. |
| Plugin to external provider | Prompt instructions, note context, attachments, workflow prompt, model request. | User provider configuration and privacy controls. |
| Provider output to vault | Text output, generated PNG, result notes, Apply writes. | Output mode, Apply scope, diff preview, confirmations, exact matching, frontmatter policy. |
| CI to release users | `main.js`, `manifest.json`, `styles.css`. | Version check, tests, build, asset attestation. |

## Apply safety boundaries

| Safety gate | Evidence | Behavior |
| --- | --- | --- |
| Captured-file targeting | `request.context.file`, `getOpenMarkdownViewForFile` | Writes aim at the captured note rather than an arbitrary active note. |
| Exact selected text matching | `findExactOccurrences` | Selected text Apply requires current selection or exactly one occurrence. |
| Full-note confirmation | `confirmTextApplyPreview` | Full-note replacement requires confirmation even when diff preview is disabled. |
| Truncated-context confirmation | `confirmTruncatedContextFullApply` | Full-note Apply warns when the model did not receive the whole note. |
| Frontmatter policy | `prepareFrontmatterAwareApply` | Preserve, confirm, or replace YAML frontmatter based on settings. |
| Review queue | `queueReviewItemFromRequest`, `applyReviewQueueItem` | Defers writes for later review from settings. |

## Notes

The most privacy-sensitive operation is sending note-derived context to external providers. The most integrity-sensitive operation is writing provider output back to the vault. Both paths are visible in the sidebar through preview or action controls and are backed by explicit source-level safety checks.

## Traceability

| Field | Details |
| --- | --- |
| Source files inspected | `SECURITY.md`, `CONTRIBUTING.md`, `src/plugin/AskMatePlugin.ts`, `src/ui/sidebar/AskMateView.ts`, `src/ui/modals/modals.ts`, `src/providers/types.ts`, `src/providers/index.ts`, `src/shared/types.ts`, `.github/workflows/release.yml` |
| Key symbols | `RequestPrivacyOptions`, `getProviderApiKey`, `app.secretStorage.getSecret`, `requestJson`, `buildPromptContextContent`, `applyResponseToContext`, `confirmTruncatedContextFullApply`, `prepareFrontmatterAwareApply` |
| Inferences | GitHub Actions is shown as a release trust boundary because it produces public assets, not because it runs inside the plugin. |
| Confidence | confirmed |
| Open questions | Live provider privacy policies are outside repository scope and were not reviewed. |
