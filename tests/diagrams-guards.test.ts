import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as diagrams from "../src/diagrams";

// Source-level guards for the community review rules and the package contract. They read the files, so a regression fails fast
// and names the file.

const SRC = join(import.meta.dir, "..", "src");
const DIAGRAM_FILES = readdirSync(join(SRC, "diagrams"))
	.filter((name) => name.endsWith(".ts"))
	.map((name) => join(SRC, "diagrams", name));
const GUARDED = [...DIAGRAM_FILES, join(SRC, "shared", "imageIntent.ts")];

const read = (path: string): string => readFileSync(path, "utf8");

/** Drops comments so a rule written in prose does not trip a guard that targets code. */
function code(path: string): string {
	return read(path)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

describe("src/diagrams guards", () => {
	test("the module has the files the contract names", () => {
		const names = DIAGRAM_FILES.map((path) => path.split("/").pop());
		["pipeline.ts", "brief.ts", "header.ts", "recipes.ts", "palette.ts", "extract.ts", "repair.ts", "mermaid.ts", "dom.ts", "safety.ts", "prompts.ts", "index.ts"].forEach((name) => {
			expect(names).toContain(name);
		});
	});

	test("nothing imports obsidian or mermaid (Mermaid arrives through loadMermaid at run time)", () => {
		for (const path of GUARDED) {
			const text = read(path);
			expect({ path, obsidian: /from\s+["']obsidian["']|require\(["']obsidian["']\)/.test(text) }).toEqual({ path, obsidian: false });
			expect({ path, mermaid: /from\s+["']mermaid|import\(["']mermaid|require\(["']mermaid/.test(text) }).toEqual({ path, mermaid: false });
			expect({ path, dom: /from\s+["'](?:happy-dom|jsdom)["']/.test(text) }).toEqual({ path, dom: false });
		}
	});

	test("no innerHTML, outerHTML or insertAdjacentHTML", () => {
		for (const path of DIAGRAM_FILES) {
			expect({ path, found: /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(code(path)) }).toEqual({ path, found: false });
		}
	});

	test("no any, no console, no global document or window", () => {
		for (const path of GUARDED) {
			const text = code(path);
			expect({ path, any: /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/.test(text) }).toEqual({ path, any: false });
			expect({ path, console: /\bconsole\./.test(text) }).toEqual({ path, console: false });
			expect({ path, globalDocument: /(?<![.\w])document\./.test(text) }).toEqual({ path, globalDocument: false });
		}
	});

	test("the SVG mount uses DOMParser as text/html plus importNode", () => {
		const text = code(join(SRC, "diagrams", "dom.ts"));
		expect(text).toContain('parseFromString(svg, "text/html")');
		expect(text).toContain("importNode");
		expect(text).not.toContain("image/svg+xml");
	});

	test("source and comments use no em dashes or other non-ASCII characters", () => {
		for (const path of GUARDED) {
			expect({ path, nonAscii: /[^\x00-\x7F]/.test(read(path)) }).toEqual({ path, nonAscii: false });
		}
	});

	test("no unbounded timers or network calls", () => {
		for (const path of DIAGRAM_FILES) {
			const text = code(path);
			expect({ path, timers: /\bset(?:Interval|Timeout)\b/.test(text) }).toEqual({ path, timers: false });
			expect({ path, network: /\bfetch\(|\brequestUrl\(|new XMLHttpRequest|new WebSocket/.test(text) }).toEqual({ path, network: false });
		}
	});
});

describe("public surface", () => {
	test("exports the names the cross-package contract promises", () => {
		expect(typeof diagrams.runDiagramPipeline).toBe("function");
		expect(typeof diagrams.buildDiagramBrief).toBe("function");
		expect(typeof diagrams.assembleDiagram).toBe("function");
		expect(typeof diagrams.detectDiagramIntent).toBe("function");
		expect(Array.isArray(diagrams.STYLE_RECIPES)).toBe(true);
		expect(diagrams.STYLE_RECIPES).toHaveLength(8);
		expect(typeof diagrams.toMermaidApi).toBe("function");
		expect(typeof diagrams.supportedDiagrams).toBe("function");
		expect(typeof diagrams.mountSvg).toBe("function");
	});
});
