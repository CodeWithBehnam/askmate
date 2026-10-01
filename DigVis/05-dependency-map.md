# Dependency Map

## Purpose

Show internal module dependencies, external provider dependencies, and build or release dependencies.

## Diagram

```mermaid
flowchart TD
  Entry["main.ts"] --> Plugin["AskMatePlugin"]
  Plugin --> UI["AskMateView and AskMateSettingTab"]
  Plugin --> Modals["modals.ts"]
  Plugin --> Services["ContextService, HistoryService, UsageService"]
  Plugin --> Runner["RequestRunner and requestBuilders"]
  Plugin --> Output["src/output/*"]
  UI --> RenderSafety["renderSafety.ts"]
  Runner --> Providers["src/providers/index.ts"]
  Plugin --> Settings["src/settings/*"]
  Plugin --> Shared["src/shared/*"]
  Plugin --> Workflows["builtInWorkflows.ts"]

  Providers --> OpenAI["open-ai.ts"]
  Providers --> AzureOpenAI["azure-open-ai.ts"]
  Providers --> AzureAI["azure-ai.ts"]
  Providers --> OpenRouter["open-router.ts"]
  Providers --> Anthropic["anthropic.ts"]
  Providers --> Gemini["google-gemini.ts"]
  Providers --> Compatible["open-ai-compatible.ts"]

  Build["package scripts"] --> TypeScript["tsc no emit"]
  Build --> Esbuild["esbuild CJS bundle"]
  Build --> Bun["Bun runtime"]
  Build --> Tests["bun test tests and smoke script"]
  CI["GitHub CI workflow"] --> Build
  Release["GitHub release workflow"] --> Build
  Release --> Assets["main.js, manifest.json, styles.css"]

  subgraph "Runtime dependencies"
    Entry
    Plugin
    UI
    Modals
    Services
    Runner
    Output
    RenderSafety
    Providers
    Settings
    Shared
    Workflows
  end

  subgraph "External providers"
    OpenAI
    AzureOpenAI
    AzureAI
    OpenRouter
    Anthropic
    Gemini
    Compatible
  end

  subgraph "Tooling"
    Build
    TypeScript
    Esbuild
    Bun
    Tests
    CI
    Release
    Assets
  end

  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0F172A
  classDef external fill:#F3E8FF,stroke:#9333EA,color:#3B0764
  classDef test fill:#DCFCE7,stroke:#16A34A,color:#14532D
  classDef config fill:#F1F5F9,stroke:#64748B,color:#0F172A

  class Entry,Plugin,UI,Modals,Services,Runner,Output,RenderSafety,Providers,Settings,Shared,Workflows core
  class OpenAI,AzureOpenAI,AzureAI,OpenRouter,Anthropic,Gemini,Compatible external
  class Build,TypeScript,Esbuild,Bun,Tests,CI,Release test
  class Assets config
```

## Runtime dependencies

| Dependency | Evidence | Notes |
| --- | --- | --- |
| Obsidian plugin API | `manifest.json`, imports from `obsidian` | Desktop-only plugin with `minAppVersion` `1.11.4`. |
| Provider APIs | `src/providers/*`, `README.md` | OpenAI, Azure OpenAI, Azure AI Foundry, OpenRouter, Anthropic, Gemini, local OpenAI-compatible. |
| Obsidian `requestUrl` | `AskMatePlugin.requestJson()` | Required by project review rules and provider runtime. |
| Obsidian `SecretStorage` | `getProviderApiKey()` | Settings hold secret names, not raw keys. |
| Obsidian vault API | `vault.create`, `vault.createBinary`, `vault.process`, `vault.cachedRead`, `vault.on("rename")`, `vault.on("delete")` | Used for result notes, images, Apply, context, and keeping note history and the review queue in step with renamed or deleted notes. |

## Tooling dependencies

| Tool | Evidence | Purpose |
| --- | --- | --- |
| Bun | `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` | Scripts, `bun test` suite, build, CI and release setup (Bun pinned to 1.4.2 in CI). |
| TypeScript | `package.json`, `tsconfig.json` | Type checking before build with `strict`, `noUnusedLocals` and `noUnusedParameters`. `tests/` is excluded from `tsc`. |
| esbuild | `esbuild.config.mjs` | Bundles `main.ts` to `main.js` as CJS targeting ES2018. |
| GitHub Actions | `.github/workflows/ci.yml`, `.github/workflows/release.yml` | CI runs tests and build; release adds version validation, asset attestation and release. Actions are pinned to commit SHAs. |

## Traceability

| Field | Details |
| --- | --- |
| Source files inspected | `main.ts`, `package.json`, `manifest.json`, `tsconfig.json`, `esbuild.config.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src/providers/*`, `src/plugin/AskMatePlugin.ts`, `src/requests/RequestRunner.ts` |
| Key symbols | `completeProviderTextRequest`, `fetchProviderModels`, `requestOpenAIResponses`, `requestOpenAIImageGeneration`, `ProviderRuntime`, `requestJson` |
| Inferences | Provider files are grouped by external service, while local OpenAI-compatible endpoints are treated as an external boundary because they are reached by HTTP. |
| Confidence | confirmed |
| Open questions | Exact provider feature support should be checked against live APIs before changing adapter behavior. |
