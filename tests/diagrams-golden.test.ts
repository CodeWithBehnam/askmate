// Golden parse tests against the real Mermaid parser (dev dependency only; nothing from mermaid is imported by src). At runtime the
// diagram pipeline validates every diagram with the Mermaid that Obsidian itself bundles.
// happy-dom stands in for the browser. It is enough for `parse`, which is all the golden tests need; the render step is faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { assembleDiagram, buildConfig } from "../src/diagrams/header";
import { applyDeterministicRepairs } from "../src/diagrams/repair";
import { detectKind } from "../src/diagrams/extract";
import { supportedDiagrams, toMermaidApi } from "../src/diagrams/mermaid";
import { runDiagramPipeline } from "../src/diagrams/pipeline";
import { designFromRecipe, STYLE_RECIPES } from "../src/diagrams/recipes";
import { localSafetyCheck } from "../src/diagrams/safety";
import { DIAGRAM_KINDS, type Design, type Kind, type MermaidApi } from "../src/diagrams/types";

const GLOBALS = ["window", "document", "navigator", "DOMParser", "Element", "HTMLElement", "SVGElement", "Node", "getComputedStyle"] as const;

/** Each body parses and renders on Obsidian's bundled Mermaid (11.13.0) and on the dev dependency. One per family. */
const GOLD: Readonly<Record<Kind, string>> = {
	flowchart: `flowchart TD
  accTitle: Safe apply workflow
  accDescr: A note is read, a draft is produced, the user reviews a diff and then applies it.
  n[("Note")]:::ink --> d["Draft answer"]:::primary
  d --> v{"Valid?"}:::accent
  v -- "yes" --> r["Review diff"]:::primary
  v -- "no" --> f["Repair once"]:::warn
  f --> v
  r --> ok(["Apply to note"]):::success
  r -.-> x["Discard"]:::muted
  r --> bad["Fail"]:::danger`,
	sequence: `sequenceDiagram
  autonumber
  actor U as User
  participant S as AskMate
  participant P@{ "type": "database" } as Provider
  U->>+S: Ask about this note
  S->>+P: Request with note context
  P-->>-S: Streamed answer
  alt answer is valid
    S-->>U: Show answer
  else needs repair
    S->>P: Repair request
  end
  Note over S,P: Context stays local until sent
  S-->>-U: Offer Apply`,
	class: `classDiagram
  direction LR
  class Thread:::primary {
    +String id
    +List~Message~ messages
    +save() void
  }
  class Message:::accent {
    <<value>>
    +Role role
    +String text
  }
  class Provider {
    <<interface>>
    +send(Request) Response
  }
  Thread "1" *-- "many" Message : holds
  Thread ..> Provider : uses`,
	state: `stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Streaming : send
  state Streaming {
    [*] --> Waiting
    Waiting --> Receiving : first token
    Receiving --> [*] : done
  }
  Streaming --> Review : complete
  state check <<choice>>
  Review --> check
  check --> Applied : accept
  check --> Idle : reject
  Applied --> [*]
  class Idle primary
  class Applied success
  class Review accent`,
	er: `erDiagram
  direction LR
  THREAD:::primary ||--o{ MESSAGE:::accent : contains
  NOTE ||--o{ THREAD : "is discussed in"
  THREAD {
    string id PK
    string title
    datetime updated_at
  }
  MESSAGE {
    string id PK
    string thread_id FK
    string role
  }`,
	gantt: `gantt
  title Release plan
  dateFormat YYYY-MM-DD
  axisFormat %d %b
  excludes weekends
  section Build
  Design :done, des, 2026-11-02, 4d
  Implement :active, imp, after des, 8d
  section Ship
  Test :crit, tst, after imp, 4d
  Release :milestone, rel, after tst, 0d`,
	pie: `pie showData title Requests by provider
  "OpenAI" : 46
  "Anthropic" : 31
  "Gemini" : 14
  "Local" : 9`,
	quadrant: `quadrantChart
  title Feature priority
  x-axis Low effort --> High effort
  y-axis Low value --> High value
  quadrant-1 Plan carefully
  quadrant-2 Do first
  quadrant-3 Maybe later
  quadrant-4 Quick wins
  Mermaid skill: [0.35, 0.9]
  MCP servers: [0.75, 0.8]
  Dark logo: [0.2, 0.3]
  Saved threads: [0.3, 0.65]`,
	mindmap: `mindmap
  root((AskMate))
    Ask
      Note context
      Mentions
    Create
      Diagrams
      Images
    Safety
      Preview before apply
      No hidden writes`,
	timeline: `timeline
  title AskMate history
  section 2026
    1.10 : Workflows
    1.11 : Streaming : Saved threads
    1.12 : Mermaid skill`,
	gitGraph: `gitGraph
  commit id: "init"
  branch feature
  checkout feature
  commit id: "diagram"
  commit id: "tests" tag: "rc1"
  checkout main
  merge feature tag: "v1.12"
  commit id: "docs"`,
	sankey: `sankey-beta

Vault,Notes,60
Vault,Attachments,25
Vault,Templates,15
Notes,Read by AskMate,20
Notes,Untouched,40`,
	xychart: `xychart-beta
  title "Questions per week"
  x-axis [w1, w2, w3, w4, w5]
  y-axis "Questions" 0 --> 60
  bar [12, 25, 31, 44, 52]
  line [12, 25, 31, 44, 52]`,
	block: `block-beta
  columns 3
  ui["Sidebar"]:3
  space:1 core["Core"] space:1
  ctx["Context"] prov["Providers"] out["Output"]
  ui --> core
  core --> ctx
  core --> prov
  core --> out
  class ui primary
  class core accent`,
	packet: `packet-beta
  title Thread record
  0-15: "Version"
  16-31: "Flags"
  32-63: "Created at"
  64-95: "Message count"`,
	kanban: `kanban
  todo[Todo]
    t1[Write skill prompt]@{ priority: 'High' }
    t2[Ship README]
  doing[Doing]
    t3[Mermaid validator]@{ assigned: 'Ana' }
  done[Done]
    t4[Streaming]`,
	architecture: `architecture-beta
  group app(cloud)[Obsidian]
  service ui(server)[Sidebar] in app
  service core(server)[Core] in app
  service store(disk)[Threads] in app
  service llm(internet)[Provider]
  ui:R -- L:core
  core:B -- T:store
  core:R --> L:llm`,
	radar: `radar-beta
  title Provider fit
  axis speed["Speed"], cost["Cost"], privacy["Privacy"], quality["Quality"], tools["Tools"]
  curve cloud["Cloud"]{4, 2, 2, 5, 5}
  curve local["Local"]{2, 5, 5, 3, 2}
  max 5
  graticule polygon`,
	treemap: `treemap-beta
  "Vault"
    "Notes"
      "Projects": 40:::primary
      "Daily": 25
    "Assets"
      "Images": 20:::accent
      "PDFs": 15`,
	journey: `journey
  title First run
  section Setup
    Install plugin: 4: User
    Add API key: 3: User
  section Use
    Ask a question: 5: User, AskMate
    Apply a draft: 4: User`,
	requirement: `requirementDiagram
  requirement safe_apply {
    id: R1
    text: "Never write without a preview"
    risk: high
    verifymethod: test
  }
  element diff_modal {
    type: "ui component"
  }
  diff_modal - satisfies -> safe_apply`,
	c4: `C4Context
  title AskMate context
  Person(user, "Writer", "Uses notes")
  System(am, "AskMate", "Obsidian plugin")
  System_Ext(llm, "LLM provider", "Answers")
  Rel(user, am, "Asks")
  Rel(am, llm, "Sends context", "HTTPS")`,
	venn: `venn-beta
  set A["Notes"]:30
  set B["Tasks"]:20
  union A,B["Meeting notes"]:8`,
	ishikawa: `ishikawa-beta
  Diagram does not render
  Syntax
    Unquoted label
    Reserved word end
  Config
    Unsupported theme
  Environment
    Vault trust off`
};

type Json = Readonly<Record<string, unknown>>;

const LDQUO = String.fromCharCode(0x201c);
const RDQUO = String.fromCharCode(0x201d);

/** Every key and value in `emitted` must come back from the parser unchanged: Mermaid silently drops unknown keys and unsafe values. */
function missingFrom(emitted: unknown, returned: unknown, path = ""): readonly string[] {
	if (typeof emitted !== "object" || emitted === null) {
		return emitted === returned ? [] : [`${path}: emitted ${JSON.stringify(emitted)}, parser kept ${JSON.stringify(returned)}`];
	}
	const returnedObject: Json = typeof returned === "object" && returned !== null ? (returned as Json) : {};
	return Object.entries(emitted as Json).flatMap(([key, value]) => missingFrom(value, returnedObject[key], path === "" ? key : `${path}.${key}`));
}

const designs = (): readonly { readonly name: string; readonly design: Design }[] => [
	...STYLE_RECIPES.map((recipe) => ({ name: recipe.name, design: designFromRecipe(recipe, 20260101) })),
	{ name: "hand drawn seed 7", design: { hue: 300, mood: "pastel", accentOffset: 150, look: "handDrawn", seed: 7 } },
	{ name: "bare design", design: { hue: 0, mood: "ink", accentOffset: 0, look: "classic", seed: 1 } }
];

let saved: Partial<Record<(typeof GLOBALS)[number], PropertyDescriptor | undefined>> = {};
let api: MermaidApi;
let rawParse: (text: string) => Promise<false | { diagramType: string; config?: unknown }>;

beforeAll(async () => {
	const win = new Window();
	const view = win as unknown as Record<string, unknown>;
	saved = Object.fromEntries(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
	Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
	GLOBALS.slice(1).forEach((name) => Object.defineProperty(globalThis, name, { value: view[name], configurable: true, writable: true }));
	const mermaid = (await import("mermaid")).default;
	mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
	const adapted = toMermaidApi(mermaid);
	if (adapted === null) throw new Error("mermaid is not Mermaid-shaped");
	api = adapted;
	rawParse = async (text) => (await mermaid.parse(text, { suppressErrors: true })) as false | { diagramType: string; config?: unknown };
});

afterAll(() => {
	GLOBALS.forEach((name) => {
		const descriptor = saved[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	});
});

describe("capability probe against the real Mermaid parser", () => {
	test("every diagram family is supported by the bundled build", async () => {
		expect([...(await supportedDiagrams(api))].sort()).toEqual([...DIAGRAM_KINDS].sort());
	});

	test("the gold bodies cover every family and name their own family", () => {
		expect(Object.keys(GOLD).sort()).toEqual([...DIAGRAM_KINDS].sort());
		DIAGRAM_KINDS.forEach((kind) => expect(detectKind(GOLD[kind])).toBe(kind));
	});

	test("an unsupported family is reported as unsupported", async () => {
		expect(await api.parse("notARealDiagram-beta\n  title X\n  component A", { suppressErrors: true })).toBe(false);
	});
});

describe("every style recipe parses for every diagram family", () => {
	test.each(designs().map((entry) => [entry.name, entry.design] as const))("%s", async (_name, design) => {
		for (const kind of DIAGRAM_KINDS) {
			const source = assembleDiagram(GOLD[kind], kind, design);
			const parsed = await rawParse(source);
			expect(parsed === false ? `${kind}: rejected\n${source}` : "ok").toBe("ok");
			if (parsed === false) continue;
			expect(parsed.diagramType.length).toBeGreaterThan(0);
			// The parser returns the merged frontmatter config after its own sanitiser ran over it.
			expect({ kind, missing: missingFrom(buildConfig(kind, design), parsed.config) }).toEqual({ kind, missing: [] });
		}
	});
});

describe("what Mermaid's own config sanitiser drops", () => {
	// Mermaid 11.13 blanks any themeVariables string outside /^[\d "#%(),.;A-Za-z]+$/. That is why recipe fonts have no hyphens or apostrophes.
	test("a font stack with a hyphen or an apostrophe is blanked, so the survival check would notice", async () => {
		const base = designFromRecipe(STYLE_RECIPES[0], 1);
		for (const family of ["ui-monospace, monospace", "Georgia, 'Times New Roman', serif"]) {
			const design: Design = { ...base, font: { family, size: "13px" } };
			const parsed = await rawParse(assembleDiagram(GOLD.flowchart, "flowchart", design));
			expect(parsed).not.toBe(false);
			if (parsed === false) continue;
			expect(missingFrom(buildConfig("flowchart", design), parsed.config).some((line) => line.startsWith("themeVariables.fontFamily"))).toBe(true);
		}
	});

	test("every recipe font survives", async () => {
		for (const recipe of STYLE_RECIPES.filter((entry) => entry.font !== undefined)) {
			const design = designFromRecipe(recipe, 5);
			const parsed = await rawParse(assembleDiagram(GOLD.flowchart, "flowchart", design));
			const config = parsed === false ? {} : (parsed.config as { themeVariables?: { fontFamily?: string } });
			expect({ id: recipe.id, font: config.themeVariables?.fontFamily }).toEqual({ id: recipe.id, font: recipe.font?.family });
		}
	});
});

describe("plugin classDef lines work with role tags", () => {
	const tagged: readonly Kind[] = ["flowchart", "state", "class", "er", "block", "treemap"];
	test.each(tagged.map((kind) => [kind] as const))("%s keeps its role tags valid once the classDef lines are appended", async (kind) => {
		const design = designFromRecipe(STYLE_RECIPES[0], 1);
		const source = assembleDiagram(GOLD[kind], kind, design);
		expect(source).toContain("classDef primary ");
		expect(source).toContain("classDef danger ");
		expect(await rawParse(source)).not.toBe(false);
	});
});

/** Each broken body is rejected by the real parser, then accepted once the deterministic repairs ran. */
const REPAIR_CASES: ReadonlyArray<{ readonly name: string; readonly kind: Kind; readonly body: string; readonly step: string }> = [
	{ name: "parentheses in a flowchart label", kind: "flowchart", body: "flowchart TD\n  A[Cost (est)] --> B", step: "flowchart-labels" },
	{ name: "parentheses in an edge label", kind: "flowchart", body: "flowchart TD\n  A -->|Yes (maybe)| B", step: "flowchart-labels" },
	{ name: "a quote inside a label", kind: "flowchart", body: 'flowchart TD\n  A["Say "hi" now"] --> B', step: "flowchart-labels" },
	{ name: "an at sign in a label", kind: "flowchart", body: "flowchart TD\n  A[Mail@home] --> B", step: "flowchart-labels" },
	{ name: "a pipe in a label", kind: "flowchart", body: "flowchart TD\n  A[Text with | pipe] --> B", step: "flowchart-labels" },
	{ name: "a leading slash in a label", kind: "flowchart", body: "flowchart TD\n  A[/path] --> B", step: "flowchart-labels" },
	{ name: "a pipe and colon in a decision label", kind: "flowchart", body: "flowchart TD\n  A{Pick: yes|no} --> B", step: "flowchart-labels" },
	{ name: "a risky subgraph title", kind: "flowchart", body: "flowchart TD\n  subgraph one [Phase (1)]\n    A --> B\n  end", step: "flowchart-labels" },
	{ name: "typographic quotes around a risky label", kind: "flowchart", body: `flowchart TD\n  A[${LDQUO}Step (1)${RDQUO}] --> B`, step: "normalise-text" },
	{ name: "end used as a node id", kind: "flowchart", body: "flowchart TD\n  start --> end", step: "flowchart-reserved-end" },
	{ name: "end as a labelled target", kind: "flowchart", body: "flowchart TD\n  A --> B\n  B --> end[Finish]", step: "flowchart-reserved-end" },
	{ name: "a single-dash arrow", kind: "flowchart", body: "flowchart TD\n  A -> B", step: "flowchart-arrows" },
	{ name: "a subgraph without end", kind: "flowchart", body: "flowchart TD\n  subgraph one\n    A --> B", step: "flowchart-subgraph-end" },
	{ name: "a semicolon in a sequence message", kind: "sequence", body: "sequenceDiagram\n  A->>B: first; second", step: "sequence-escapes" },
	{ name: "a semicolon in a sequence note", kind: "sequence", body: "sequenceDiagram\n  A->>B: hello\n  Note over A,B: a; b", step: "sequence-escapes" },
	{ name: "a percent sign in a pie value", kind: "pie", body: 'pie title Share\n  "A" : 50%\n  "B" : 50%', step: "pie-values" },
	{ name: "a thousands separator in a pie value", kind: "pie", body: 'pie\n  "A" : 1,200\n  "B" : 300', step: "pie-values" }
];

describe("deterministic repairs against the real parser", () => {
	test.each(REPAIR_CASES.map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
		expect(await rawParse(entry.body)).toBe(false);
		const repaired = applyDeterministicRepairs(entry.body, entry.kind);
		expect(repaired.applied).toContain(entry.step);
		expect(await rawParse(repaired.body)).not.toBe(false);
	});

	test("valid bodies pass through untouched", () => {
		DIAGRAM_KINDS.forEach((kind) => {
			const result = applyDeterministicRepairs(GOLD[kind], kind);
			expect({ kind, applied: result.applied, same: result.body === GOLD[kind] }).toEqual({ kind, applied: [], same: true });
		});
	});
});

describe("the pipeline with the real parser", () => {
	const scratch = { open: () => ({ container: { remove: () => undefined } as unknown as Element, close: () => undefined }) };
	const realParseFakeRender: MermaidApi = {
		parse: (text, options) => api.parse(text, options),
		render: async () => ({ svg: "<svg></svg>" })
	};
	const design = designFromRecipe(STYLE_RECIPES[1], 99);

	test("a broken answer is repaired without a model turn", async () => {
		const outcome = await runDiagramPipeline({
			api: realParseFakeRender,
			raw: "Here you go:\n```mermaid\nflowchart TD\n  A[Cost (est)] --> B\n  B -> end\n```\nShows: costs.",
			safety: localSafetyCheck,
			scratch,
			design
		});
		expect(outcome.status).toBe("valid");
		if (outcome.status !== "valid") return;
		expect(outcome.modelRepairs).toBe(0);
		expect(outcome.repairs).toEqual(expect.arrayContaining(["flowchart-labels", "flowchart-reserved-end", "flowchart-arrows"]));
		expect(outcome.source.startsWith("---\nconfig: ")).toBe(true);
		expect(outcome.prose).toContain("Shows: costs.");
	});

	test("an error the repairs cannot fix goes to exactly one model turn", async () => {
		let turns = 0;
		const outcome = await runDiagramPipeline({
			api: realParseFakeRender,
			raw: "```mermaid\nflowchart TD\n  A --> \n```",
			safety: localSafetyCheck,
			scratch,
			design,
			requestRepair: async (request) => {
				turns += 1;
				expect(request.errorLines.length).toBeLessThanOrEqual(4);
				expect(request.stage).toBe("parse");
				return "```mermaid\nflowchart TD\n  A --> B\n```";
			}
		});
		expect(turns).toBe(1);
		expect(outcome.status).toBe("valid");
		if (outcome.status === "valid") expect(outcome.modelRepairs).toBe(1);
	});

	test("a model that keeps failing ends in a visible fallback", async () => {
		const outcome = await runDiagramPipeline({
			api: realParseFakeRender,
			raw: "```mermaid\nflowchart TD\n  A --> \n```",
			safety: localSafetyCheck,
			scratch,
			design,
			requestRepair: async () => "```mermaid\nflowchart TD\n  Z -->\n```"
		});
		expect(outcome.status).toBe("fallback");
		if (outcome.status !== "fallback") return;
		expect(outcome.stage).toBe("parse");
		expect(outcome.modelRepairs).toBe(1);
		expect(outcome.body).toContain("flowchart TD");
	});
});
