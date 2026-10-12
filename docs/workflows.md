# Workflows

A workflow is a saved prompt with a short name. Run it from the sidebar, the command palette, the editor menu or the console (`/summarise`). A run from the palette or the editor menu saves its answer as a new result note.

## Built in

Study summary, Action plan, Explain simply, Question drill, Buyer protection analysis, Knowledge graph links, Mermaid diagram, Key insights, Critical review, Pros and cons, Flashcards, Meeting notes, Research map, Decision brief, Compare ideas, Translate and preserve, Quote extractor and Rewrite polish.

The Mermaid diagram workflow uses the same pipeline as `/diagram`. See [diagrams](diagrams.md).

To favourite, hide or reorder sidebar workflows, open `Workflow sidebar` on the `Advanced` settings page, under `Workflows in the sidebar`. Drag a row by its handle, or focus it and press Alt+Up or Alt+Down. Favourites always appear first and feed the editor menu. Hidden built-in workflows stay available from the command palette.

## Custom workflows

Create them under `Custom workflows`, next to `Workflow sidebar` on the same page (up to 30). Use `Add workflow`, then open the new row to edit it. The editor has `Name`, `Short name`, `Description`, `Icon`, `Accent`, `Prompt`, `Output kind`, an optional `Result note template`, `Hide from sidebar` and `Delete workflow`. A custom workflow can use these variables:

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

`Translate and preserve` uses `Translation target language` under `Workflow defaults` on the `Advanced` page. A fresh install starts with the language of your Obsidian interface (English when that is English or cannot be worked out); existing installs keep their saved language.

A workflow can carry up to three [skills](skills.md) that always apply to it. The editor has no skill field in this version, so a custom workflow gets them only through a `skillIds` list in its preset JSON.

Result and image note templates must contain the AI answer. AskMate warns you when a template would drop it.

## Batch runs

Open `Batch workflow runner` on the `Advanced` page, under `Automation`. `Batch folder`, `Batch workflow` (with the most notes to process, ten by default) and `Batch output` (`Create result notes` or `Queue proposed note changes`) choose the run, and `Run batch` starts it. AskMate asks you to confirm with the real note count first. Each file is read once with the settings in force when the run starts. A reply that comes back incomplete is not used, and a note too large to send is skipped and named in the summary. A run stops early when three notes in a row fail because the provider rejected the request or the usage guardrails blocked it, and reports an empty or missing folder instead of finishing with zero results. A queued run also stops when the review queue is full. Tools (MCP) are off in batch runs.

## Presets

`Export presets` and `Import presets` move custom workflows as JSON. Imported workflows are added and never replace yours, and a preset that does not say what it produces is imported as `New content`. AskMate asks before importing a preset whose prompt or template contains a link, an image or a template tag. Review an imported preset before you use it: a workflow is only a prompt, but it decides what gets sent to your provider and whether its output may replace a note.

## Custom instructions

The `Instructions` settings page tells AskMate how to answer, for example "answer in British English, keep a formal tone, write for a first-year student".

- `Instructions for every request` apply to every text request: questions, workflows and batch runs. They can hold up to 4,000 characters.
- `Folder instructions` add rules for notes inside a folder and its subfolders (up to 20 rules of 2,000 characters). A rule for `Projects` applies to `Projects/a.md` and `Projects/x/b.md`, not to `ProjectsOld/c.md`. Folder names are case-sensitive. When several folders match, the broadest rule comes first and the most specific last.
- `Workflow custom instructions` (on the `Advanced` page, under `Workflow defaults`) still apply to workflows only.

Instructions are added after AskMate's built-in rules and cannot override its safety, evidence or Apply rules. A skill never outranks them. They show in `/inspect`, count towards token estimates and are not used for image prompt planning. When note context is withheld for a request, folder rules are withheld too, so a folder name is not revealed.
