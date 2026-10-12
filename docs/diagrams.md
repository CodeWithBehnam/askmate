# Mermaid Diagram Studio

Ask for a diagram and get one that renders. AskMate chooses a type that fits your note, gives it a distinct look, checks it against the Mermaid that ships inside Obsidian, and only then shows it.

## Ask for one

Any of these starts the diagram path:

- Say it: `Draw this as a diagram`, `Draw a dependency map`, `Show the timeline as a Gantt chart`.
- Type `/diagram`, optionally with what to draw: `/diagram the approval flow`.
- Press the `Make a diagram` starter chip.
- Run the Mermaid diagram workflow from the command palette, or from the editor menu once you favourite it. It saves the checked diagram as a result note.
- Run the `Draw a diagram of the current note` command.
- Name the built-in skill with `@skill:mermaid-diagrams`.

Wording that asks for a diagram, such as `draw a state machine` or `draw a roadmap`, goes to the diagram path and never to paid image generation. A request for a picture, such as `/image` or `draw me a cat`, still goes to image generation. The setting `Treat "draw me a..." as an image request` on the `Sidebar and output` page turns the picture wording off, and then only `/image` and the Image button make images.

## What you get

AskMate picks the type from the shape of the content: flowchart for steps and decisions, sequence for who talks to whom, state, class, entity relationship, Gantt, timeline, mind map, quadrant, pie, user journey, Git graph, requirement and C4, and newer types such as Sankey, XY chart, block, packet, kanban, architecture, radar, treemap, Venn and Ishikawa (fishbone). The list is probed at runtime, because Obsidian versions bundle different Mermaid builds. If you name a type, AskMate uses it when it can show the content.

Diagrams use only what is in your note. They aim for about 12 nodes. When the note holds more, the diagram keeps the main structure and the reply names what was left out.

## Looks

Eight named looks. Text colours reach at least 7:1 contrast against their fills and lines at least 3.2:1, and dark themes use Obsidian's own Mermaid inversion:

| Look | Character |
| --- | --- |
| Blueprint | Right-angled connectors and a monospace face in a cool engineering blue. |
| Sketchbook | Hand-drawn strokes and soft pastel fills, like a whiteboard sketch. |
| Editorial Ink | Near-monochrome ink on paper with a serif face and generous spacing. |
| Sunrise | Warm coral and apricot pastels with gently curved connectors. |
| Lagoon | Saturated teal and sea-green with smooth, flowing connectors. |
| Grape Soda | Playful violet and magenta pastels with rounded curves. |
| Slate | Calm blue-grey tones in a clean sans-serif face, compact and quiet. |
| Terminal | Bright green on a console palette with straight lines and a monospace face. |

The starting look comes from your note title and headings, so the same note gets the same look until you ask for another. `Another look` moves to the next look in a fixed order for that note, so eight presses visit every look before one repeats.

The `Diagrams` section of the `Skills and tools` settings page has four settings: `Draw diagrams from notes` (on by default), `Default diagram type` and `Default style` (both start on automatic), and `Fix diagrams that do not draw` (on by default).

The model writes only the diagram body. AskMate adds the header and the colour classes itself, so the look is always built from its own palettes. Directives, `click` handlers, URLs, HTML, custom CSS and external layouts in model output are rejected, not repaired.

## How it is checked

1. The diagram is extracted from the reply and passed through the safety allowlist.
2. Small, deterministic fixes are applied: quotes, risky flowchart labels, text that breaks sequence diagrams, an `end` used as an id, malformed arrows.
3. Mermaid parses it. Then it is rendered in a hidden container, because a diagram can parse and still fail to draw.
4. If something still fails, AskMate asks the model once to repair it, sending only the first lines of the error and the failing line. This costs one extra request. You can turn the repair turn off with `Fix diagrams that do not draw`.
5. If it still fails, the card shows the source and the reason, and `Insert` and `New note` are disabled for that reply. Nothing is written.

Only a reply that holds a diagram which failed blocks writes. When the model answers a diagram request in words and draws no diagram, for example because the note holds nothing to draw, the reply is shown as ordinary text, and Insert, Apply and the save actions work as they do for any other reply.

While a reply is streaming, an unfinished diagram shows `Drawing the diagram...` and is drawn once, after the fence closes.

## The preview card

The card draws the diagram with Obsidian's Mermaid, even if your vault has not turned on Mermaid diagrams in notes, and follows Obsidian's dark inversion. It shows the type and look, and these actions:

| Action | What it does |
| --- | --- |
| Insert | Appends the diagram to the note you asked about, through the same checks as Apply. You see a preview first when your approval setting asks for one. |
| New note | Saves the diagram as a result note. |
| Copy source | Copies the Mermaid source. |
| Fix | Appears when a diagram did not render. Runs the check and repair again on it. |
| Another look | Draws it again in a different look. |

Newer versions of Obsidian can ask, once per vault, whether to trust Mermaid diagrams. Until you choose Trust, a note may show the source instead of the picture. AskMate says so after an insert and never changes that choice.

## Limits

- AskMate rejects a diagram body longer than 16,000 characters before it is shown. The Mermaid inside Obsidian sets its own limits too (by default 500 edges and 50,000 characters of source), and other Obsidian versions can differ, which is why AskMate checks what your build supports.
- ELK layouts and `click` handlers are rejected. `zenuml` and `wardley` diagrams are never requested.
- AskMate is tested against Mermaid 11.13.0.
- A parse that succeeds does not prove the picture is right. Check dates, labels and the shape of the relations before you rely on it.

## Skill

The built-in `mermaid-diagrams` skill holds the type guidance and syntax rules the model follows. It is always trusted and cannot be shadowed by a vault skill. See [skills](skills.md).
