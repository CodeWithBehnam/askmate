# Debugging Map

## Purpose

Show where developers should look first for common failures, logs, tests, config, and boundary bugs.

## Diagram

```mermaid
flowchart TD
  Symptom["Observed problem"] --> Kind{"Where does it appear?"}
  Kind -- "Sidebar or composer" --> Sidebar["src/ui/sidebar/AskMateView.ts"]
  Kind -- "Settings" --> Settings["src/ui/settings/AskMateSettingTab.ts"]
  Kind -- "Provider call" --> Providers["src/providers/* and requestJson"]
  Kind -- "Apply or vault write" --> Apply["AskMatePlugin Apply methods"]
  Kind -- "Prompt context" --> Context["getNoteContext and buildRequest"]
  Kind -- "Release" --> Release["package scripts and release.yml"]

  Sidebar --> Styles["styles.css"]
  Settings --> Normalize["src/settings/normalize.ts"]
  Providers --> Secrets["SecretStorage and provider settings"]
  Apply --> Modals["diff and confirm modals"]
  Context --> Preview["Request preview and prompt inspector"]
  Release --> Smoke["bun run test"]
  Release --> Build["bun run build"]

  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0F172A
  classDef decision fill:#FEF3C7,stroke:#D97706,color:#0F172A
  classDef risk fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D
  classDef test fill:#DCFCE7,stroke:#16A34A,color:#14532D
  classDef config fill:#F1F5F9,stroke:#64748B,color:#0F172A

  class Symptom,Sidebar,Settings,Providers,Apply,Context core
  class Kind decision
  class Secrets risk
  class Smoke,Build test
  class Styles,Normalize,Modals,Preview,Release config
```

## Debugging starting points

| Symptom | Start here | Then inspect | Why |
| --- | --- | --- | --- |
| Sidebar cannot send or stop request | `src/ui/sidebar/AskMateView.ts` | `activeRun`, `beginRun`, `stopActiveRun`, `runRequest` | Sidebar owns run state and abort signals. |
| Wrong note context after sidebar focus | `src/plugin/AskMatePlugin.ts` | `getNoteContext`, `rememberActiveMarkdownContext`, `lastMarkdownView`, `lastNoteContext` | Context fallback is implemented in plugin core. |
| Provider error or missing models | `src/providers/index.ts` | Provider-specific file, `getProviderApiKey`, `requestJson` | Dispatcher and runtime mediate provider requests. |
| Apply writes wrong place or refuses write | `src/plugin/AskMatePlugin.ts` | `applyResponseToContext`, `appendResponseToCapturedNote`, `applyResponseToHeadingSection` | Apply safety and targeting live in plugin core. |
| Diff or confirmation issue | `src/ui/modals/modals.ts` | `src/shared/markdownDiff.ts`, `confirmTextApplyPreview` | UI confirmation is split from decision logic. |
| Settings value resets or migrates poorly | `src/settings/normalize.ts` | `src/settings/defaults.ts`, `src/shared/types.ts` | Normalizers define migration and fallback behavior. |
| Smoke test fails | `scripts/roadmap-smoke-tests.ts` | File named in assertion | Smoke tests assert strings and regex patterns across files. |
| Release failed | `.github/workflows/release.yml` | `package.json`, `manifest.json`, `versions.json` | CI validates version and publishes assets. |

## Notes

The codebase has limited automated behavioral tests visible in the inspected files. For bugs involving Obsidian UI, provider APIs, or vault writes, combine source inspection with manual testing in a development vault.

## Traceability

| Field | Details |
| --- | --- |
| Source files inspected | `src/ui/sidebar/AskMateView.ts`, `src/plugin/AskMatePlugin.ts`, `src/providers/index.ts`, `src/ui/modals/modals.ts`, `src/shared/markdownDiff.ts`, `src/settings/normalize.ts`, `scripts/roadmap-smoke-tests.ts`, `.github/workflows/release.yml`, `CONTRIBUTING.md` |
| Key symbols | `activeRun`, `AbortController`, `getNoteContext`, `requestJson`, `applyResponseToContext`, `askMateDiffConfirm`, `normalizeProviderSettings`, `assertIncludes` |
| Inferences | The triage order is inferred from ownership and failure boundaries. |
| Confidence | inferred |
| Open questions | Actual runtime logs and Notices were not exercised. |
