# Project Map

## Purpose

Show the top-level repository structure and where key responsibilities live.

## Diagram

```mermaid
flowchart TD
  Root["AskMate repository"] --> Metadata["Plugin metadata and build config"]
  Root --> Source["src: product TypeScript"]
  Root --> Scripts["scripts: smoke tests and vault install"]
  Root --> Tests["tests: bun unit tests"]
  Root --> CI[".github: release and contribution workflow"]
  Root --> Docs["Public docs and policy"]
  Root --> DigVis["DigVis: visual documentation"]

  Source --> Plugin["src/plugin: central orchestrator"]
  Source --> Services["src/context, src/requests, src/history, src/usage: services"]
  Source --> Output["src/output: pure Apply and path helpers"]
  Source --> UI["src/ui: sidebar, settings, modals"]
  Source --> Providers["src/providers: text and image API adapters"]
  Source --> Settings["src/settings: defaults, constants, normalizers"]
  Source --> Shared["src/shared: domain types and helpers"]
  Source --> Workflows["src/workflows: built-in prompt workflows"]

  Metadata --> Package["package.json scripts"]
  Metadata --> Manifest["manifest.json Obsidian metadata"]
  Metadata --> Build["esbuild.config.mjs bundle"]
  Scripts --> Smoke["roadmap-smoke-tests.ts"]
  CI --> Release["ci.yml and release.yml"]

  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0F172A
  classDef config fill:#F1F5F9,stroke:#64748B,color:#0F172A
  classDef test fill:#DCFCE7,stroke:#16A34A,color:#14532D
  classDef external fill:#F3E8FF,stroke:#9333EA,color:#3B0764
  classDef docs fill:#FEF3C7,stroke:#D97706,color:#0F172A

  class Root,Source,Plugin,Services,Output,UI,Providers,Settings,Shared,Workflows core
  class Metadata,Package,Manifest,Build config
  class Scripts,Smoke,Tests,CI,Release test
  class Docs,DigVis docs
```

## Notes

The repository is a TypeScript Obsidian plugin. Runtime source is under `src/`, with `main.ts` (a one-line re-export) exporting the plugin class from `src/plugin/AskMatePlugin.ts`. `AskMatePlugin` wires four services (`ContextService`, `RequestRunner`, `HistoryService`, `UsageService`) and keeps Apply, vault writes and commands itself. Build and release behaviour is defined by `package.json`, `esbuild.config.mjs`, `manifest.json`, `.github/workflows/ci.yml` and `.github/workflows/release.yml`. `bun run test` runs `scripts/roadmap-smoke-tests.ts` and then the `bun test` suite in `tests/`.

## Responsibility table

| Area | Responsibility | Primary files |
| --- | --- | --- |
| Plugin entry | Obsidian loads the plugin bundle through `main.js`, sourced from `main.ts`. | `main.ts`, `manifest.json`, `esbuild.config.mjs` |
| Orchestration | Lifecycle, settings load and save, commands, vault events, Apply, result notes, images, batch runs. | `src/plugin/AskMatePlugin.ts` |
| Context capture | Remembered Markdown view and file, selection or full note, extra note, folder and history attachments. | `src/context/ContextService.ts` |
| Request building and running | Prompt and context assembly, prompt-injection escaping, provider calls, incomplete-output detection, image prompt planning. | `src/requests/RequestRunner.ts`, `src/requests/requestBuilders.ts`, `src/requests/promptSafety.ts` |
| History and review queue | Per-note history turns, review queue items, rename and delete handling. | `src/history/HistoryService.ts` |
| Usage | Usage records, per-day totals, budgets. | `src/usage/UsageService.ts` |
| Output helpers | Pure heading, frontmatter, section splice, path, template and backlink helpers used by Apply and result notes. | `src/output/*` |
| Sidebar runtime | Composer, request preview, active run state, messages, evidence chips, actions, sanitised reply rendering. | `src/ui/sidebar/AskMateView.ts`, `src/ui/sidebar/renderSafety.ts`, `styles.css` |
| Settings UI | Provider setup, privacy defaults, workflows, review queue, batch, usage. | `src/ui/settings/AskMateSettingTab.ts`, `src/ui/settings/settingsInputs.ts` |
| Provider adapters | OpenAI, Azure, OpenRouter, Anthropic, Gemini, local OpenAI-compatible text paths. | `src/providers/*` |
| Domain model | Settings, request metadata, context attachments, queue, usage, workflows. | `src/shared/types.ts`, `src/settings/*`, `src/settings/syncInPlace.ts` |
| Shared helpers | Image intent detection, diff, run and selection safety, model capabilities. | `src/shared/imageIntent.ts`, `src/shared/markdownDiff.ts`, `src/shared/trustSafety.ts`, `src/shared/modelCapabilities.ts` |
| Validation | Smoke assertions, `bun test` unit tests, TypeScript build, CI and release checks. | `scripts/roadmap-smoke-tests.ts`, `tests/*.test.ts`, `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` |

## Traceability

| Field | Details |
| --- | --- |
| Source files inspected | File tree, `main.ts`, `package.json`, `manifest.json`, `esbuild.config.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/roadmap-smoke-tests.ts`, `src/*`, `tests/*` |
| Key symbols | `AskMatePlugin`, `ContextService`, `RequestRunner`, `HistoryService`, `UsageService`, `AskMateView`, `AskMateSettingTab`, `ProviderRuntime`, `WORKFLOWS` |
| Inferences | Runtime scope is inferred from `main.ts`, `esbuild.config.mjs`, and `tsconfig.json`. |
| Confidence | confirmed |
| Open questions | None for top-level structure. |
