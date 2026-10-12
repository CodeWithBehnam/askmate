// The boundary to Mermaid. Obsidian's loadMermaid() returns an untyped object, so everything here narrows from `unknown`.

import { DIAGRAM_KINDS, type Kind, type MermaidApi } from "./types";

function isObjectLike(value: unknown): value is object {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}

function readDiagramType(result: unknown): string {
	if (!isObjectLike(result)) return "unknown";
	const diagramType: unknown = Reflect.get(result, "diagramType");
	return typeof diagramType === "string" ? diagramType : "unknown";
}

function readSvg(result: unknown): string {
	const svg: unknown = isObjectLike(result) ? Reflect.get(result, "svg") : undefined;
	if (typeof svg !== "string") throw new Error("Mermaid returned no SVG.");
	return svg;
}

/**
 * Narrows the value from `loadMermaid()` to the two methods the pipeline uses. Returns null when the object is not Mermaid-shaped,
 * so a caller can show a plain message instead of crashing on a host build that changed.
 */
export function toMermaidApi(candidate: unknown): MermaidApi | null {
	if (!isObjectLike(candidate)) return null;
	const parse: unknown = Reflect.get(candidate, "parse");
	const render: unknown = Reflect.get(candidate, "render");
	if (typeof parse !== "function" || typeof render !== "function") return null;
	return {
		parse: async (text, options) => {
			const result: unknown = await Reflect.apply(parse, candidate, [text, options]);
			return result === false ? false : { diagramType: readDiagramType(result) };
		},
		render: async (id, text, container) => ({ svg: readSvg(await Reflect.apply(render, candidate, [id, text, container])) })
	};
}

/** One tiny valid diagram per family, used to ask the host Mermaid which families it knows. */
export const PROBE_SOURCES: Readonly<Record<Kind, string>> = {
	flowchart: "flowchart TD\n A-->B",
	sequence: "sequenceDiagram\n A->>B: x",
	class: "classDiagram\n A-->B",
	state: "stateDiagram-v2\n A-->B",
	er: "erDiagram\n A ||--o{ B : x",
	gantt: "gantt\n dateFormat YYYY-MM-DD\n section S\n A :a, 2026-01-01, 1d",
	pie: 'pie\n "A": 1',
	quadrant: "quadrantChart\n x-axis L --> R\n y-axis B --> T\n A: [0.5,0.5]",
	mindmap: "mindmap\n root((R))\n  A",
	timeline: "timeline\n 2020 : x",
	gitGraph: "gitGraph\n commit",
	sankey: "sankey-beta\n\nA,B,1",
	xychart: "xychart-beta\n x-axis [a]\n bar [1]",
	block: "block-beta\n a b",
	packet: 'packet-beta\n 0-7: "A"',
	kanban: "kanban\n a[T]\n  t[x]",
	architecture: "architecture-beta\n service a(server)[A]",
	radar: "radar-beta\n axis a,b,c\n curve s{1,2,3}",
	treemap: 'treemap-beta\n "R"\n  "A": 1',
	journey: "journey\n section S\n  t: 5: Me",
	requirement: "requirementDiagram\n requirement r {\n id: 1\n text: x\n risk: low\n verifymethod: test\n }",
	c4: 'C4Context\n Person(u,"U")',
	venn: 'venn-beta\n set A["A"]',
	ishikawa: "ishikawa-beta\n Effect\n Cat\n  Cause"
};


/**
 * Asks the bundled Mermaid which diagram families it can parse. Obsidian versions bundle different Mermaid builds,
 * and `mermaid.version` is not reliable, so the answer comes from parsing real samples.
 */
export async function supportedDiagrams(api: MermaidApi): Promise<readonly Kind[]> {
	const checks = await Promise.all(
		DIAGRAM_KINDS.map(async (kind) => {
			try {
				return [kind, (await api.parse(PROBE_SOURCES[kind], { suppressErrors: true })) !== false] as const;
			} catch {
				return [kind, false] as const;
			}
		})
	);
	return checks.filter(([, supported]) => supported).map(([kind]) => kind);
}

/** The line Mermaid reports for a parse error, 1-based, relative to the text that was parsed. */
export function lineOf(error: unknown): number | undefined {
	if (!isObjectLike(error)) return undefined;
	const hash: unknown = Reflect.get(error, "hash");
	if (!isObjectLike(hash)) return undefined;
	const loc: unknown = Reflect.get(hash, "loc");
	const first: unknown = isObjectLike(loc) ? Reflect.get(loc, "first_line") : undefined;
	if (typeof first === "number") return first;
	const line: unknown = Reflect.get(hash, "line");
	return typeof line === "number" ? line + 1 : undefined;
}

/** Works across windows: an Error thrown inside a popout window is not `instanceof Error` here. */
export function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	const message: unknown = isObjectLike(error) ? Reflect.get(error, "message") : undefined;
	return typeof message === "string" ? message : "Mermaid reported an error.";
}

/** At most four lines of an error message: enough for Mermaid's caret diagram and the expected tokens, short enough for a repair prompt. */
export function firstLines(error: unknown, count = 4): readonly string[] {
	return errorText(error)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "")
		.slice(0, count);
}
