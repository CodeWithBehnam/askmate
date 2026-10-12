# Apply and output

AskMate never edits a note on its own. An answer reaches your vault only when you choose an output mode, and every write passes the checks below.

## Output modes

Choose a mode with the three buttons beside the composer before you send, or cycle it by clicking the mode in the Console status bar. `Default output` on the `Sidebar and output` page sets the starting mode.

| Mode | What happens |
| --- | --- |
| `Chat` | The answer stays in the sidebar. Nothing is written. |
| `New note` | AskMate creates a Markdown result note, placed near the source note by a naming template. |
| `Apply` | AskMate writes the generated text back into the captured source note after the safety checks. |

A `New note` or `Apply` choice covers the next answer only, and AskMate then goes back to `Chat`, so a later question never writes to your vault by surprise. A badge shows the mode whenever it is not `Chat`.

## Reply actions

Every finished reply shows `Insert`, `Copy` and `Apply`. A reply restored from a saved conversation offers `Insert` and `Copy` only. The menu next to them holds `Show reply text`, `Use reply as a new question`, `Run again without skill` (when an automatic skill shaped the reply), and then the actions that change a note: `Queue for review`, `Save as new note`, `Replace the whole note`, `Apply to the selected text` and `Apply to a heading`. A diagram reply has its own card, see [diagrams](diagrams.md).

`Copy` puts the raw Markdown on the clipboard. `Insert` writes at the cursor in the note you last edited, even when the sidebar has focus. It never replaces a selection: if text is selected, the reply goes after it, and `Apply` is the way to change selected text. AskMate checks the text before it writes. A clean reply goes in as it is. A reply that holds something that stays active in a note, such as a remote image, a plugin code block or hidden characters, is held back and you choose `Insert safe version`, `Insert anyway` or `Cancel`. A reply that was cut short is inserted with a warning. In the sidebar, the notice names the note that was written to. The command palette has `Copy last answer` and `Insert last answer at cursor` for the newest reply; the palette version always inserts the safe version.

## What Apply does

Apply targets the note that was captured when the request was built, not whichever note is open now.

- With selected text, it replaces exactly that text, and stops if it can no longer find it.
- With no selection, default Apply appends generated output to the captured note instead of overwriting anything.
- A heading section can be replaced, and a full-note replacement must be explicit and confirmed.
- Frontmatter can be preserved, confirmed or replaced during an explicit full-note Apply (`Frontmatter Apply handling` on the `Advanced` page), and line endings (LF or CRLF) are kept.
- A suggested change can be queued for later review instead of applied.

Before it replaces text, AskMate checks that the note did not change while you were looking at the preview, and refuses if it did. An append goes to the end of the note as it is when you confirm. `Default partial Apply scope` on the `Advanced` page sets what a plain Apply does: `Auto` replaces selected text or else appends.

## Apply approval mode

The `Apply approval mode` setting decides how often you see a diff before a text write. On the `Sidebar and output` page it is called `Ask before changing my notes`.

| Mode | Setting text | Behaviour |
| --- | --- | --- |
| `Manual` (default) | Every time | Asks with a diff before every text Apply write. |
| `Full` | When replacing a whole note or a section | Asks with a diff for full-note and heading-section replacements, and skips selected-text and append previews. |
| `Auto approve` | Only when replacing the whole note | Skips the diff for selected-text, append and heading-section writes. Full-note replacement is still confirmed. |

An unknown or damaged value is treated as the strictest mode, not the loosest. No mode switches off captured-note targeting, exact selected-text matching, the explicit full-note confirmation, the truncated-context confirmation or the frontmatter safeguards.

Two things override the mode. A reply that was written from tool results (MCP) always opens the diff, and it cannot be queued for later review. When AskMate had to change the reply to make it safe, or the text it adds holds something active such as a script block, a remote image, a template tag or hidden characters, the write stops with a confirmation that names the problem, even in `Auto approve`. The diff modal makes invisible and bidirectional characters visible.

## When AskMate refuses to replace text

- The reply is incomplete: it hit the token limit, was filtered, was refused or the stream broke. An incomplete reply can still be appended or inserted, with a warning.
- The note or selection was cut short by the context budget. AskMate asks for confirmation before any replacement.
- `Send note and attached context` was off for the request, so the model never saw the text. AskMate offers append instead. The same applies when image references were withheld and the text being replaced contains images.

## Review queue

`Queue for review` keeps every pending suggestion until you apply or dismiss it. Review them on the `Pending reviews` page under `Review queue` on the `Advanced` page. The `Review queue max items` limit never drops a pending item: when pending items reach it, AskMate refuses to queue more until you review some. Applied and dismissed items keep only metadata (note path, title and question), not the note text. Queued items and note history follow a note when you rename it and are removed when you delete it.

## What the sanitiser does on the way in

Model text is untrusted. Before it is rendered in the sidebar, and again before it is written by Insert, Apply, a result note, an image note, an export or the review queue, AskMate:

- turns remote images into plain links, so nothing loads;
- shows HTML that would load a resource (`img`, `iframe`, `video`, `link`, `style` and similar) as text;
- relabels code blocks in languages that other plugins execute (`dataviewjs`, `dataview`, `tasks` and similar) as plain text;
- blocks links to `obsidian://`, `file:`, `javascript:` and other schemes. Only vault links and `http(s)` links stay clickable;
- neutralises Templater tags, and removes zero-width and bidirectional control characters when text is written;
- checks every Mermaid diagram against an allowlist and refuses remote loading, directives and scripts.

When you rewrite a note, constructs that were already in your note are left alone, so a faithful rewrite of a note that holds a Dataview block keeps it, while a new one added by the model is neutralised. The one exception is `Insert anyway`, which writes a reply as it is after you have read the warning.

## Diagrams

A Mermaid diagram reaches a note through the same checks. `Insert` on a diagram card appends the diagram the way Apply does, `New note` creates a result note, and a diagram that failed validation cannot be inserted or saved as a note. See [diagrams](diagrams.md).
