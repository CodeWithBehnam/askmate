import type { SkillDefinition } from "../render";

const fence = (...lines: string[]): string => ["```mermaid", ...lines, "```"].join("\n");

/*
 * Written to be read by a model, not a person. Keep it free of anything the skill sanitiser would remove (comment
 * markers, double-brace sequences) and of the syntax it forbids: tests/skills-builtin.test.ts checks both, and parses
 * every example below with the Mermaid build that ships in Obsidian.
 */
const BODY = [
	"# Goal",
	"Turn the note and the request into one Mermaid diagram that a reader understands in under 30 seconds and that renders in Obsidian without errors.",
	"",
	"# Success criteria",
	"- Every node, label, number, date and relation comes from the note or the request. Nothing is invented.",
	"- The type is the one the user asked for, or else fits the shape of the content, and it is available (see Type choice).",
	"- About 12 nodes or fewer, with labels under about 40 characters. When the content is larger, keep its most important structure in this one diagram, leave out the least important detail, and name what was left out in the sentence after the block.",
	"- The code follows the Syntax rules, so it parses on the first attempt.",
	"- It reads at sidebar width: one idea per node, one shape per meaning, short labels.",
	"",
	"# Type choice",
	"If the user names a type, in the request or in the design brief, and it can show the content, use it. Otherwise choose by the shape of the content. Write the exact keyword. If the design brief lists the available types, choose only from that list; otherwise use the core types.",
	"",
	"Core types:",
	"- Steps, decisions, processes, \"how does X work\": flowchart (write flowchart, never graph)",
	"- Messages between people or systems over time: sequenceDiagram",
	"- Entities and how they relate: erDiagram",
	"- Types with fields and methods: classDiagram",
	"- A lifecycle with named states: stateDiagram-v2",
	"- Tasks with dates and durations: gantt",
	"- Dated events or history: timeline",
	"- A brainstorm or a hierarchy of ideas: mindmap",
	"- Shares of a whole: pie",
	"- One person's steps with scores: journey",
	"- Items placed on two axes: quadrantChart",
	"- Branches and merges: gitGraph",
	"",
	"Newer types, only when the design brief lists them:",
	"- Amounts flowing between nodes: sankey-beta",
	"- Numbers over categories or time: xychart-beta",
	"- Services, databases and groups in a system: architecture-beta",
	"- Blocks on a grid: block-beta",
	"- Options compared on several axes: radar-beta",
	"- A hierarchy sized by value: treemap-beta",
	"- Overlap between sets: venn-beta",
	"- Causes of one problem: ishikawa-beta",
	"- Work items in columns: kanban",
	"- Field layout by bit: packet-beta",
	"- System context in C4 terms: C4Context",
	"",
	"# Syntax rules",
	"Write only the diagram body. Its first line is the type keyword, plus a direction such as LR or TD for a flowchart.",
	"",
	"- Ids use ASCII letters, digits and underscores and start with a letter. Never use end as an id, never give two labels the same id, and keep every subgraph id different from every node id.",
	"- Put quotes around any node label (not sequence message text) that has ( ) [ ] { } < > : ; | # % & or non-English text, for example A[\"Cost (est.)\"]. Write a double quote inside a label as #quot;. Use <br/> for a line break.",
	"- Close every subgraph with end. After an arrow, leave a space before an id that starts with o or x.",
	"- Sequence message text is never quoted and has no semicolons or hash characters (write #59; and #35;). Timeline events and quadrant point names have no colons.",
	"- Pie values are plain numbers such as 40, never 40%. A gantt sets dateFormat YYYY-MM-DD and uses only dates that exist.",
	"- A mindmap uses indentation and plain text: no Markdown bullets and no brackets.",
	"- Entity names in erDiagram have no spaces; use underscores.",
	"- Never write click handlers, links or URLs, init or directive blocks, theme, look or layout settings, ELK, raw HTML other than the line break, or source and citation IDs in labels.",
	"",
	"Valid shapes for the newer types:",
	fence(
		"quadrantChart",
		"    title Priorities",
		"    x-axis Low effort --> High effort",
		"    y-axis Low value --> High value",
		"    quadrant-1 Plan",
		"    quadrant-2 Do first",
		"    quadrant-3 Skip",
		"    quadrant-4 Delegate",
		"    Docs: [0.3, 0.6]"
	),
	fence(
		"sankey-beta",
		"",
		"Budget,Housing,500",
		"Budget,Food,300"
	),
	fence(
		"xychart-beta",
		"    title \"Sales\"",
		"    x-axis [jan, feb, mar]",
		"    y-axis \"Units\" 0 --> 100",
		"    bar [30, 60, 45]"
	),
	fence(
		"architecture-beta",
		"    group api(cloud)[API]",
		"    service db(database)[Database] in api",
		"    service server(server)[Server] in api",
		"    db:L -- R:server"
	),
	fence(
		"block-beta",
		"    columns 3",
		"    a[\"Input\"] b[\"Process\"] c[\"Output\"]",
		"    a --> b",
		"    b --> c"
	),
	fence(
		"kanban",
		"  todo[To do]",
		"    t1[Write draft]",
		"  done[Done]",
		"    t2[Publish]"
	),
	fence(
		"radar-beta",
		"    title Options",
		"    axis s[\"Speed\"], q[\"Quality\"], c[\"Cost\"]",
		"    curve a[\"Option A\"]{4, 3, 2}",
		"    max 5"
	),
	fence(
		"treemap-beta",
		"\"Budget\"",
		"    \"Housing\": 500",
		"    \"Food\": 300"
	),
	fence(
		"venn-beta",
		"    title Overlap",
		"    set A[\"Readers\"]",
		"    set B[\"Writers\"]",
		"    union A,B[\"Editors\"]"
	),
	fence(
		"ishikawa-beta",
		"    Late release",
		"        People",
		"            Too few reviewers",
		"        Process",
		"            No checklist"
	),
	fence(
		"packet-beta",
		"    0-15: \"Source port\"",
		"    16-31: \"Destination port\""
	),
	"",
	"# Design brief",
	"The request may carry a design brief: the available types, a style name, the colour roles with their meanings, and the types that take role tags. The plugin writes the configuration header and the colour definitions itself, so write the body only.",
	"",
	"- Tag a node with a role the way the brief shows for its type, for example by adding the role after three colons in a flowchart, as in the example below. Tag only the types the brief names; the plugin styles every other type, so add nothing there.",
	fence(
		"flowchart LR",
		"    accTitle: Review flow",
		"    accDescr: A draft is reviewed, then published or revised.",
		"    A[\"Draft\"]:::primary --> B{\"Reviewed?\"}",
		"    B -- yes --> C[\"Publish\"]:::success",
		"    B -- no --> D[\"Revise\"]:::warn",
		"    D --> A"
	),
	"- Use the roles and meanings the brief gives. Keep to the few that carry meaning, and one role per meaning.",
	"- Never write colours, fill or stroke values, style or classDef lines, fonts or spacing.",
	"- Group related nodes with a subgraph, and add the title line when the type has one.",
	"- In flowchart, sequenceDiagram, classDiagram, stateDiagram-v2 and erDiagram, add accTitle and accDescr lines under the type line: a short title and one sentence for screen readers.",
	"",
	"# Output",
	"Return one fenced mermaid code block. After it, add one plain sentence only when you assumed something or left something out, and say which. No labels, no headings and no offers of further help.",
	"",
	"Keep labels in the language of the note and reuse the names the note uses. When asked to fix, restyle or extend an existing diagram, keep its content, change only what was asked and return the whole block again.",
	"",
	"# Stop rules",
	"- If the note has too little structure for a useful diagram, draw the smallest diagram it supports. Only when there is nothing to draw, answer in one or two plain sentences that say what is missing, with no code block. Do not invent content to fill the gap.",
	"- If the request is not asking for a diagram, skip this skill and answer normally.",
	"- If the plugin reports a syntax error, fix only that error, return the whole block again and stop."
].join("\n");

export const MERMAID_DIAGRAMS_SKILL: SkillDefinition = {
	name: "mermaid-diagrams",
	title: "Mermaid diagrams",
	description:
		"Designs one valid Mermaid diagram from a note or a request, for Obsidian. Use when the user wants a diagram, flowchart, mind map, sequence diagram, timeline, ER diagram, state diagram, Gantt chart, architecture diagram or any visual map of the note, or asks to fix, restyle or extend a Mermaid block. Produces one fenced Mermaid block that renders in Obsidian.",
	whenToUse: "The request asks to draw, map, diagram, visualise or chart something, or to repair a Mermaid block.",
	triggers: [
		"mermaid",
		"flowchart",
		"flow chart",
		"diagram",
		"mind map",
		"mindmap",
		"sequence diagram",
		"er diagram",
		"entity relationship",
		"state diagram",
		"gantt",
		"class diagram",
		"visualise",
		"visual map",
		"visually",
		"org chart",
		"architecture diagram",
		"journey map",
		"swimlane",
		"relationship map",
		"sketch a flow",
		"draw the architecture",
		"as a graph",
		"timeline diagram"
	],
	version: "1.0.0",
	icon: "workflow",
	accent: "#352FA0",
	outputKind: "diagram",
	license: "MIT",
	compatibility: "Obsidian 1.13 or newer, which bundles Mermaid 11. Dagre layout only.",
	body: BODY
};
