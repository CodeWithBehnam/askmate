# Apply and output

AskMate never edits a note on its own. An answer reaches your vault only when you choose an output mode, and every write passes the checks below.

## Output modes

Choose a mode before you send, or cycle it by clicking the mode in the Console status bar.

| Mode | What happens |
| --- | --- |
| `Chat` | The answer stays in the sidebar. Nothing is written. |
| `New note` | AskMate creates a Markdown result note, placed near the source note by a naming template. |
| `Apply` | AskMate writes the generated text back into the captured source note after the safety checks. |

Every finished reply also has `Copy` (the raw Markdown goes to the clipboard) and `Insert at cursor`. Insert writes at the cursor in the note you last edited, even when the sidebar has focus. It never replaces a selection: if text is selected, the reply goes after it, and `Apply` is the way to change selected text. AskMate checks the text before it writes, and a reply that was cut short is inserted with a warning. The command palette has `Copy last answer` and `Insert last answer at cursor` for the newest reply. <!-- TODO(lead): confirm this paragraph against the merged src/ui/sidebar/answerShell.ts (WP-10, VIEW-14): the selection collapses to its end, the text is checked first, and the success notice names the target note. The base code still calls editor.replaceSelection. -->

## What Apply does

Apply targets the note that was captured when the request was built, not whichever note is open now.

- With selected text, it replaces exactly that text, and stops if it can no longer find it.
- With no selection, default Apply appends generated output to the captured note instead of overwriting anything.
- A heading section can be replaced, and a full-note replacement must be explicit and confirmed.
- Frontmatter can be preserved, confirmed or replaced during an explicit full-note Apply, and line endings (LF or CRLF) are kept.
- A suggested change can be queued for later review instead of applied.

Before writing, AskMate checks that the note did not change while you were looking at the preview, and refuses if it did.

## Apply approval mode

The `Apply approval mode` setting decides how often you see a diff before a text write.

| Mode | Behaviour |
| --- | --- |
| `Auto approve` | Skips the diff for selected-text, append and heading-section writes. Full-note replacement is still confirmed. |
| `Full` | Asks with a diff for full-note and heading-section replacements, and skips selected-text and append previews. |
| `Manual` | Asks with a diff before every text Apply write. |

An unknown or damaged value is treated as the strictest mode, not the loosest. No mode switches off captured-note targeting, exact selected-text matching, the explicit full-note confirmation, the truncated-context confirmation or the frontmatter safeguards.

A diff is also shown, whatever the mode, when the text comes from a tool call (MCP), or when it contains something active such as a script block, a remote image, a template tag or hidden characters. The diff modal makes invisible and bidirectional characters visible. <!-- TODO(lead): the forced diff for tool-derived or active content (PLG-15, UI-06) lands in wave 2. Confirm before release. -->

## When AskMate refuses to replace text

- The reply is incomplete: it hit the token limit, was filtered, was refused or the stream broke. An incomplete reply can still be appended or inserted, with a warning.
- The note or selection was cut short by the context budget. AskMate asks for confirmation before any replacement.
- `Send note and attached context` was off for the request, so the model never saw the text. AskMate offers append instead. The same applies when image references were withheld and the text being replaced contains images.

## Review queue

Queue for review keeps every pending suggestion until you apply or dismiss it. The `Review queue max items` limit never drops a pending item: when pending items reach it, AskMate refuses to queue more until you review some. Applied and dismissed items keep only metadata (note path, title and question), not the note text. Queued items and note history follow a note when you rename it and are removed when you delete it.

## What the sanitiser does on the way in

Model text is untrusted. Before it is rendered in the sidebar, and again before it is written by Insert, Apply, a result note, an export or the review queue, AskMate:

- turns remote images into plain links, so nothing loads;
- shows HTML that would load a resource (`img`, `iframe`, `video`, `link`, `style` and similar) as text;
- relabels code blocks in languages that other plugins execute (`dataviewjs`, `dataview`, `tasks` and similar) as plain text;
- blocks links to `obsidian://`, `file:`, `javascript:` and other schemes. Only vault links and `http(s)` links stay clickable;
- neutralises Templater tags, and removes zero-width and bidirectional control characters when text is written;
- checks every Mermaid diagram against an allowlist and refuses remote loading, directives and scripts.

When you rewrite a note, constructs that were already in your note are left alone, so a faithful rewrite of a note that holds a Dataview block keeps it, while a new one added by the model is neutralised. <!-- TODO(lead): confirm that Insert, Apply, result notes, exports and the review queue all call the write-path sanitiser in the merged build (WP-07 handoff to WP-11). -->

## Diagrams

A Mermaid diagram reaches a note through the same preview. `Insert` on a diagram card shows the Apply preview, `New note` creates a result note, and a diagram that failed validation cannot be inserted or saved as a note. See [diagrams](diagrams.md).
