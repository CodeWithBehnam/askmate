# Commands, layouts and mentions

AskMate has three sidebar layouts. Slash commands and `@` mentions work in all of them.

## Layouts

| Layout | Best for |
| --- | --- |
| Compact | Fresh installs start here. Denser, with a Send button and a line that shows what will be sent. |
| Expanded | More room for the composer. |
| Console | Keyboard-first. Monospaced, one line per event, and a status bar with the output mode, model, reasoning effort and today's token use (or the share of your daily budget). Setup, skills and tools segments appear beside them when they apply. |

Fresh installs start in Compact. Existing installs keep the layout they saved. Switch at any time with `/layout compact`, `/layout expanded` or `/layout console`, or under `Sidebar layout` on the `Sidebar and output` settings page.

## Command palette

Obsidian adds the `AskMate:` prefix itself.

| Command | What it does |
| --- | --- |
| Open sidebar | Opens or focuses AskMate. |
| Ask about current note | Opens the sidebar with the open note ready. |
| Draw a diagram of the current note | Starts the [diagram](diagrams.md) path for the open note. |
| New conversation | Starts a new sidebar conversation. The current one stays saved. |
| Open settings | Opens the AskMate settings. |
| Stop current run | Stops the workflow or image run that the palette or editor menu started. |
| Generate image from current note | Runs image generation for the note. Needs an OpenAI key. |
| Export conversation to note | Writes the current conversation to a Markdown note. |
| Test provider connection | Checks the provider, key and model. Sends no note content. |
| Copy last answer | Copies the raw Markdown of the newest reply. |
| Insert last answer at cursor | Inserts the newest reply into the note you last edited. |
| One command per workflow | Runs that workflow on the selection or the note and saves the answer as a new result note. Custom workflows are added and removed straight away. |

Only one palette or editor menu run goes at a time. A second is refused until the first finishes or you stop it.

## Editor menu

Select text and right-click for an AskMate section. `Ask about selection` opens the sidebar with the composer focused (in Console it is prefilled with `@selection `). Up to six favourite workflows follow; with none starred you get Rewrite polish, Explain simply, Study summary and Translate and preserve. A workflow chosen here runs like its palette command and saves a result note. With no selection, the menu offers `Ask about this note`. Turn the menu off with `Show AskMate in the editor context menu` on the `Sidebar and output` page.

## Slash commands

Type `/` in the composer. Press `Tab` or `Enter` to complete, so `/pol` becomes `/polish`. A short form runs only when it matches one command. `/clear` and `/delete-thread` run only when typed in full. Start a line with `//` to send a question that begins with a slash.

| Command | Aliases | What it does |
| --- | --- | --- |
| `/help` | `/?`, `/commands` | List commands, workflows and mentions. |
| `/setup` | `/connect` | Connect an AI provider. |
| `/welcome` | | Show the welcome card again. |
| `/diagram [what to draw]` | | Draw a Mermaid diagram of the note. |
| `/skills` | | List the skills AskMate can use. |
| `/skill <name> [question]` | | Use a skill for one question, or for the whole conversation. |
| `/chat [question]` | | Answer in the sidebar. With text, for one question only. |
| `/note [question]` | `/new-note` | Save answers as new notes. |
| `/apply [question]` | | Write answers into the note. |
| `/image <prompt>` | `/img` | Generate an image with OpenAI Images. |
| `/images [on\|off]` | | Turn image previews of linked pictures on or off. |
| `/effort <level>` | `/reasoning` | Reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`. |
| `/context` | `/ctx` | Show what the next request would send. |
| `/inspect [question]` | `/prompt` | Open the final prompt before sending. |
| `/history` | | Show AskMate history for this note. |
| `/clear` | `/cls` | Start a new conversation. The old one stays saved. |
| `/layout <layout>` | | Switch layout. |
| `/model [id]` | `/models` | Show or switch the model. Add `!` for an ID that is not listed. |
| `/provider [id]` | `/providers` | Show or switch the chat provider. |
| `/test` | | Test the connection to the provider. |
| `/mcp` | | Show tool servers and their status. |
| `/export [title]` | | Export this conversation to a note. |
| `/new` | `/new-thread` | Start a new conversation. The current one stays saved. |
| `/threads` | | Switch to a saved conversation. |
| `/rename <title>` | | Rename the current conversation. |
| `/delete-thread` | | Delete a saved conversation after you confirm. |

Every workflow also has a command named after its short name, for example `/summarise`, `/critique`, `/translate` and `/polish`. Text after it is added as extra instructions for that run.

```text
/polish keep it short
/note list the risks
/model my-finetune!
/effort high
```

A `Note` or `Apply` output mode, whether chosen with the buttons, the Console status bar or a setting, covers the next answer only. AskMate then goes back to `Chat`.

## Mentions

Add mentions anywhere in the line to choose what is sent.

```text
@selection        only the selected text; AskMate stops if nothing is selected
@note             the whole note, even when text is selected
@folder           notes in the folder set under Folder context path
@folder:Projects  notes in a folder you name
@[[Vendors]]      another note as extra context
@links            notes the current note links to, in the order they appear
@backlinks        notes that link to the current note, most links first
@tag:project      notes with that tag in the body or frontmatter
@recent           the 5 most recently modified notes; @recent:10 for the most, up to 10
@skill:name       use a skill for this question
```

`@tag:` ignores case, the `#` is optional, and `@tag:project` also matches `#project/alpha`. Each of `@links`, `@backlinks`, `@tag:` and `@recent` attaches at most 10 notes, which count against your context budget and per-note size limits. `/context` lists which notes were included and which were left out. A note, folder or tag that finds nothing is reported instead of skipped. Mentions can sit next to punctuation (`Summarise @note.`). A backslash (`\@word`) sends the word as text, and mentions inside code spans or code blocks are never read.

Keys: `Tab` or `Enter` accepts the highlighted suggestion, the up arrow recalls earlier input, and `Esc` closes suggestions or stops a running request.

## Conversations

AskMate keeps your sidebar chat as a named thread that survives restarts. Titles default to your first question. `/export` writes the conversation to a Markdown note in your AskMate result folder, with your questions and the replies as separate sections, links to the notes each question was asked about, and incomplete replies marked. The same actions sit in the sidebar header, next to the request context and note history buttons.

AskMate keeps up to 50 threads of 200 messages each. Turn saving off, or delete every saved thread, with `Remember conversations` and `Delete saved conversations` on the `Privacy and memory` page. With saving off, a conversation you leave with `/new` or `/clear` is not kept. See [privacy](privacy.md) for what a thread contains.

## Streaming

Text replies appear as the provider generates them. Stop cancels the HTTP request itself. `Note` and `Apply` output modes still write only after the reply has finished. A reply that uses MCP tools arrives in one piece. If the stream cannot be opened (a local server, an Azure resource or a proxy that refuses requests from Obsidian), AskMate falls back to one buffered response. HTTP errors such as 401 or 429 are reported as they are and are not retried. If a stream breaks part-way, AskMate keeps the partial text, marks it incomplete and will not use it to replace note text. `Stream replies` is under `Answers` on the `Sidebar and output` page and is on by default.
