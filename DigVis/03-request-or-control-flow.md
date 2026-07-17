# Request Or Control Flow

## Purpose

Show the main runtime flows for text requests, image generation, workflows, Apply, review queue, and batch processing.

## Diagram: sidebar text request

```mermaid
sequenceDiagram
  autonumber
  participant User as User
  participant View as AskMateView
  participant Plugin as AskMatePlugin
  participant Provider as Provider adapter
  participant Obsidian as Obsidian APIs

  User->>View: Enter question or command
  View->>View: submitQuestion and parseComposerCommand
  View->>View: beginRun with AbortController
  View->>Plugin: buildRequest(question, title, options)
  Plugin->>Obsidian: getNoteContext and build attachments
  Plugin->>Plugin: buildPromptContextContent and evidence sources
  View->>Plugin: runOpenAIRequest(request)
  Plugin->>Provider: streamOpenAI or completeProviderTextRequest
  Provider->>Obsidian: requestUrl through ProviderRuntime
  Obsidian-->>Provider: provider response
  Provider-->>Plugin: text and usage
  Plugin->>Plugin: recordOperationUsage
  Plugin-->>View: text result
  View-->>User: Render answer and actions
```

## Diagram: flow styling legend

```mermaid
flowchart TD
  U["User action"] --> C["Core AskMate flow"]
  C --> E["External provider"]
  C --> S["Vault or settings store"]
  C --> R["Risk or failure path"]

  classDef user fill:#CCFBF1,stroke:#0F766E,color:#0F172A
  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0F172A
  classDef external fill:#F3E8FF,stroke:#9333EA,color:#3B0764
  classDef store fill:#FFEDD5,stroke:#EA580C,color:#7C2D12
  classDef risk fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D

  class U user
  class C core
  class E external
  class S store
  class R risk
```

## Diagram: image, Apply, review queue, and batch branches

```mermaid
flowchart TD
  Start["Request starts"] --> Intent{"Image intent or image-capable model?"}
  Intent -- "Yes" --> Plan["prepareImagePrompt"]
  Plan --> Image["generateOpenAIImage"]
  Image --> ImageOutput{"Output mode"}
  ImageOutput -- "Chat" --> ChatImage["Render image in sidebar"]
  ImageOutput -- "Note" --> ImageNote["Save PNG and create image result note"]
  ImageOutput -- "Apply" --> InsertImage["Insert image embed into captured note"]

  Intent -- "No" --> Text["Text provider response"]
  Text --> TextOutput{"Output mode or action"}
  TextOutput -- "Chat" --> ChatText["Render answer"]
  TextOutput -- "Note" --> ResultNote["Create result note"]
  TextOutput -- "Apply" --> Apply["applyResponseToContext"]
  TextOutput -- "Review" --> Queue["queueReviewItemFromRequest"]
  Queue --> Settings["Apply or dismiss in settings tab"]

  Batch["Batch workflow in settings"] --> FileLoop["List Markdown files in folder"]
  FileLoop --> Text
  Batch --> Queue

  classDef core fill:#E0F2FE,stroke:#0284C7,color:#0F172A
  classDef decision fill:#FEF3C7,stroke:#D97706,color:#0F172A
  classDef store fill:#FFEDD5,stroke:#EA580C,color:#7C2D12
  classDef risk fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D
  classDef user fill:#CCFBF1,stroke:#0F766E,color:#0F172A

  class Start,Plan,Image,Text,Apply,FileLoop core
  class Intent,ImageOutput,TextOutput decision
  class ImageNote,InsertImage,ResultNote,Queue,Settings store
  class Batch,ChatImage,ChatText user
```

## Notes

`AskMateView` gates concurrent requests with `activeRun` and an `AbortController`. `AskMatePlugin.buildRequest()` classifies intent, captures note context, applies privacy and context budget settings, builds context attachments, expands workflow prompts, and creates evidence sources for text requests. `runOpenAIRequest()` then chooses text or image behavior. Text requests go to OpenAI Responses for the OpenAI provider or to the provider dispatcher for other providers. Image requests use OpenAI image generation after optional prompt planning.

Apply and review queue flows are safety-sensitive because they modify vault content. `applyResponseToContext()` chooses selected text, append, heading, or full-note behavior and routes through confirmations or diff previews depending on settings.

## Traceability

| Field | Details |
| --- | --- |
| Source files inspected | `src/ui/sidebar/AskMateView.ts`, `src/plugin/AskMatePlugin.ts`, `src/providers/index.ts`, `src/providers/open-ai.ts`, `src/shared/types.ts`, `src/ui/settings/AskMateSettingTab.ts` |
| Key symbols | `submitQuestion`, `runRequest`, `beginRun`, `buildRequest`, `runOpenAIRequest`, `completeProviderTextRequest`, `prepareImagePrompt`, `generateOpenAIImage`, `applyResponseToContext`, `queueReviewItemFromRequest`, `runBatchWorkflow` |
| Inferences | The batch path is simplified as a loop over Markdown files. The implementation records per-file success and failure details. |
| Confidence | confirmed |
| Open questions | Manual cancellation behavior should be tested against slow real providers. |
