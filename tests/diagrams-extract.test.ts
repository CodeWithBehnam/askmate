import { describe, expect, test } from "bun:test";
import { detectKind, extractDiagram, extractDiagramParts, findMermaidFences, sourceHash, splitHeader } from "../src/diagrams/extract";
import { DIAGRAM_KINDS, type Kind } from "../src/diagrams/types";
import { KIND_KEYWORDS } from "../src/diagrams/header";

describe("extractDiagram", () => {
	const cases: ReadonlyArray<readonly [string, string, string]> = [
		["a fenced block with prose around it", "Sure!\n```mermaid\nflowchart TD\n  A --> B\n```\nDone.", "flowchart TD\n  A --> B"],
		["prose before an unfenced diagram", "Here you go:\nflowchart TD\n  A --> B", "flowchart TD\n  A --> B"],
		["an untagged fence that holds a diagram", "```\nflowchart TD\n  A --> B\n```", "flowchart TD\n  A --> B"],
		["a mmd fence", "```mmd\nsequenceDiagram\n  A->>B: hi\n```", "sequenceDiagram\n  A->>B: hi"],
		["a tilde fence", "~~~mermaid\nmindmap\n  root((R))\n~~~", "mindmap\n  root((R))"],
		["a longer fence marker", "````mermaid\nflowchart TD\n  A --> B\n````", "flowchart TD\n  A --> B"],
		["CRLF line endings", "```mermaid\r\nflowchart TD\r\n  A --> B\r\n```", "flowchart TD\n  A --> B"],
		["an unclosed fence while streaming", "Here:\n```mermaid\nflowchart TD\n  A --> B", "flowchart TD\n  A --> B"],
		["plan comments before the keyword", "```mermaid\n%% plan: A then B\nflowchart TD\n  A --> B\n```", "flowchart TD\n  A --> B"],
		["a mermaid fence after a code fence of another language", "```js\nconst a = 1;\n```\n```mermaid\npie\n  \"A\" : 1\n```", 'pie\n  "A" : 1'],
		["a model that opens with frontmatter", "```mermaid\n---\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B\n```", "---\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B"],
		["an init directive", "```mermaid\n%%{init: {\"theme\": \"dark\"}}%%\nflowchart TD\n  A --> B\n```", '%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B']
	];

	test.each(cases)("%s", (_name, raw, expected) => {
		expect(extractDiagram(raw)).toBe(expected);
	});

	test("a Markdown rule in prose is not mistaken for frontmatter", () => {
		expect(extractDiagram("Intro\n---\nMore prose\nflowchart TD\n  A --> B")).toBe("flowchart TD\n  A --> B");
	});

	test("prose that merely starts with a keyword is not a diagram", () => {
		expect(extractDiagram("Timeline of events was long.\nPie charts are fun.\nBlock quotes are nice.")).toBe(
			"Timeline of events was long.\nPie charts are fun.\nBlock quotes are nice."
		);
		expect(detectKind("Timeline of events")).toBeNull();
		expect(detectKind("Pie charts are fun")).toBeNull();
		expect(detectKind("block quotes")).toBeNull();
	});

	test("returns the prose around the fence and whether the block was tagged", () => {
		const parts = extractDiagramParts("Here is the plan.\n```mermaid\nflowchart TD\n  A --> B\n```\nShows: a link.\nAssumptions: none.");
		expect(parts.body).toBe("flowchart TD\n  A --> B");
		expect(parts.prose).toBe("Here is the plan.\n\nShows: a link.\nAssumptions: none.");
		expect(parts.fenced).toBe(true);
		expect(parts.taggedMermaid).toBe(true);
	});

	test("never throws on garbage", () => {
		const garbage = ["", "   ", "```", "```mermaid", "````mermaid\n", "\u0000\u0001", "```mermaid\n```\n```mermaid\n```", "---\n---", "%%{", "x".repeat(50000)];
		garbage.forEach((raw) => {
			expect(() => extractDiagramParts(raw)).not.toThrow();
			expect(typeof extractDiagram(raw)).toBe("string");
		});
	});

	test("an answer with no diagram yields an empty or non-diagram body", () => {
		expect(extractDiagram("")).toBe("");
		expect(detectKind(extractDiagram("I cannot draw that from the note."))).toBeNull();
		expect(extractDiagramParts("plain").taggedMermaid).toBe(false);
	});
});

describe("detectKind", () => {
	test.each(DIAGRAM_KINDS.map((kind) => [kind, KIND_KEYWORDS[kind]] as const))("%s starts with %s", (kind, keyword) => {
		expect(detectKind(`${keyword}\n  x`)).toBe(kind);
	});

	const variants: ReadonlyArray<readonly [string, Kind]> = [
		["graph LR", "flowchart"],
		["flowchart", "flowchart"],
		["flowchart-elk TD", "flowchart"],
		["stateDiagram", "state"],
		["classDiagram-v2", "class"],
		["sankey", "sankey"],
		["xychart-beta horizontal", "xychart"],
		["pie showData title Pets", "pie"],
		["pie title Pets", "pie"],
		["gitGraph LR:", "gitGraph"],
		["C4Container", "c4"],
		["treemap", "treemap"],
		["block", "block"]
	];
	test.each(variants)("accepts the variant %p", (line, kind) => {
		expect(detectKind(line)).toBe(kind);
	});

	test("skips headers, blank lines and comments before the keyword", () => {
		expect(detectKind('---\nconfig: {"theme":"base"}\n---\n\n%% note\nflowchart TD\n  A --> B')).toBe("flowchart");
		expect(detectKind('%%{init: {"theme":"base"}}%%\nsequenceDiagram\n  A->>B: x')).toBe("sequence");
	});

	test("an unknown family is null", () => {
		expect(detectKind("wardley-beta\n  title X")).toBeNull();
		expect(detectKind("zenuml\n  A.method()")).toBeNull();
		expect(detectKind("")).toBeNull();
	});
});

describe("splitHeader", () => {
	test("separates frontmatter and directives from the diagram", () => {
		const source = '---\nconfig: {"theme":"base"}\n---\n%%{init: {"a":1}}%%\nflowchart TD\n  A --> B';
		const { header, rest } = splitHeader(source);
		expect(header).toBe('---\nconfig: {"theme":"base"}\n---\n%%{init: {"a":1}}%%\n');
		expect(rest).toBe("flowchart TD\n  A --> B");
	});

	test("a body without a header is returned whole", () => {
		expect(splitHeader("flowchart TD\n  A --> B")).toEqual({ header: "", rest: "flowchart TD\n  A --> B" });
	});
});

describe("findMermaidFences", () => {
	test("reports closed and still-open blocks with offsets", () => {
		const text = "Intro\n```mermaid\nflowchart TD\n  A --> B\n```\nMid\n```mermaid\npie\n  \"A\" : 1";
		const fences = findMermaidFences(text);
		expect(fences.map((fence) => [fence.source, fence.closed])).toEqual([
			["flowchart TD\n  A --> B", true],
			['pie\n  "A" : 1', false]
		]);
		expect(text.slice(fences[0]?.start, fences[0]?.end)).toBe("```mermaid\nflowchart TD\n  A --> B\n```");
		expect(fences[1]?.end).toBe(text.length);
	});

	test("ignores other languages", () => {
		expect(findMermaidFences("```js\nlet a;\n```")).toEqual([]);
	});
});

describe("sourceHash", () => {
	test("is stable, short and sensitive to every character", () => {
		expect(sourceHash("flowchart TD\n A-->B")).toBe(sourceHash("flowchart TD\n A-->B"));
		expect(sourceHash("flowchart TD\n A-->B")).not.toBe(sourceHash("flowchart TD\n A-->C"));
		expect(sourceHash("x")).toMatch(/^[0-9a-f]{8}$/);
	});
});
