# Workflows

A workflow is a saved prompt with a short name. Run it from the sidebar, the command palette, the editor menu or the console (`/summarise`).

## Built in

Study summary, Action plan, Explain simply, Question drill, Buyer protection analysis, Knowledge graph links, Mermaid diagram, Key insights, Critical review, Pros and cons, Flashcards, Meeting notes, Research map, Decision brief, Compare ideas, Translate and preserve, Quote extractor and Rewrite polish.

The Mermaid diagram workflow uses the same pipeline as `/diagram`. See [diagrams](diagrams.md).

To favourite, hide or reorder sidebar workflows, open `Workflow sidebar` under `Workflows and automation` in settings. Drag a row by its handle, or focus it and press Alt+Up or Alt+Down. Favourites always appear first and feed the editor menu.

## Custom workflows

Create them under `Custom workflows` in settings (up to 30). Each opens in its own editor page, which also has `Delete workflow`. A custom workflow can use these variables:

```text
{{noteTitle}}
{{sourcePath}}
{{contextSource}}
{{selectedText}}
{{currentDate}}
{{currentDateTime}}
{{customInstructions}}
```

Each workflow has an `Output kind`:

- `Revised note`: the output is a full revised version of the note and may replace it.
- `New content`: summaries, analysis or other new material that is appended or saved as a note.

In batch runs with review-queue mode, revised-note output is queued as a full-note replacement and new-content output as an append. Custom workflow commands are added, renamed and removed straight away, including after an import, with no restart.

`Translate and preserve` uses `Translation target language` under `Workflows and automation`. New installs default to English; existing installs keep their saved language.

A workflow can name up to three [skills](skills.md) that always apply to it. <!-- TODO(lead): confirm where the skill picker sits in the workflow editor. -->

Result and image note templates must contain the AI answer. AskMate warns you when a template would drop it.

## Batch runs

`Batch workflow`, `Batch folder` and `Batch output` in settings run one workflow over the notes in a folder, ten files by default. Each file is read once with the settings in force when the run starts. A run stops early on an authentication error instead of failing on every file, and reports an empty or missing folder instead of finishing with zero results. Tools (MCP) are off in batch runs.

## Presets

`Export presets` and `Import presets` move custom workflows as JSON. Review an imported preset before you use it: a workflow is only a prompt, but it decides what gets sent to your provider and whether its output may replace a note.

## Custom instructions

The `Instructions` settings page tells AskMate how to answer, for example "answer in British English, keep a formal tone, write for a first-year student".

- `Instructions for every request` apply to every text request: questions, workflows and batch runs.
- `Folder instructions` add rules for notes inside a folder and its subfolders. A rule for `Projects` applies to `Projects/a.md` and `Projects/x/b.md`, not to `ProjectsOld/c.md`. Folder names are case-sensitive. When several folders match, the broadest rule comes first and the most specific last.
- `Workflow custom instructions` still apply to workflows only.

Instructions are added after AskMate's built-in rules and cannot override its safety, evidence or Apply rules. A skill never outranks them. They show in `/inspect`, count towards token estimates and are not used for image prompt planning. When note context is withheld for a request, folder rules are withheld too, so a folder name is not revealed.
