import { describe, expect, test } from "bun:test";
import { detectKind } from "../src/diagrams/extract";
import { errorText, firstLines, lineOf, PROBE_SOURCES, supportedDiagrams, toMermaidApi } from "../src/diagrams/mermaid";
import { DIAGRAM_KINDS, type Kind, type MermaidApi } from "../src/diagrams/types";

describe("toMermaidApi", () => {
	test.each([
		["null", null],
		["undefined", undefined],
		["a number", 42],
		["a string", "mermaid"],
		["an empty object", {}],
		["parse only", { parse: () => undefined }],
		["non-function members", { parse: 1, render: 2 }]
	])("refuses %s", (_name, candidate) => {
		expect(toMermaidApi(candidate)).toBeNull();
	});

	test("binds the methods to the original object, as loadMermaid() results need", async () => {
		class FakeMermaid {
			readonly calls: string[] = [];
			async parse(text: string, options?: { suppressErrors?: boolean }): Promise<unknown> {
				this.calls.push(`parse:${text}:${String(options?.suppressErrors)}`);
				return { diagramType: "flowchart-v2", config: {} };
			}
			async render(id: string, text: string, container?: Element): Promise<unknown> {
				this.calls.push(`render:${id}:${text}:${container === undefined ? "no container" : "container"}`);
				return { svg: "<svg></svg>", bindFunctions: () => undefined };
			}
		}
		const mermaid = new FakeMermaid();
		const api = toMermaidApi(mermaid);
		expect(api).not.toBeNull();
		if (api === null) return;
		expect(await api.parse("flowchart TD", { suppressErrors: true })).toEqual({ diagramType: "flowchart-v2" });
		expect(await api.render("id-1", "flowchart TD", {} as Element)).toEqual({ svg: "<svg></svg>" });
		expect(mermaid.calls).toEqual(["parse:flowchart TD:true", "render:id-1:flowchart TD:container"]);
	});

	test("normalises odd results instead of passing them on", async () => {
		const odd = toMermaidApi({ parse: async () => false, render: async () => ({}) }) as MermaidApi;
		expect(await odd.parse("x")).toBe(false);
		await expect(odd.render("id", "x")).rejects.toThrow("Mermaid returned no SVG.");

		const strange = toMermaidApi({ parse: async () => "yes", render: async () => null }) as MermaidApi;
		expect(await strange.parse("x")).toEqual({ diagramType: "unknown" });
		await expect(strange.render("id", "x")).rejects.toThrow("Mermaid returned no SVG.");
	});

	test("lets Mermaid's own errors through", async () => {
		const api = toMermaidApi({
			parse: async () => {
				throw new Error("Parse error on line 2");
			},
			render: async () => ({ svg: "" })
		}) as MermaidApi;
		await expect(api.parse("x")).rejects.toThrow("Parse error on line 2");
	});
});

describe("supportedDiagrams", () => {
	const fakeApi = (accepts: (text: string) => boolean): MermaidApi & { readonly seen: { text: string; suppress?: boolean }[] } => {
		const seen: { text: string; suppress?: boolean }[] = [];
		return {
			seen,
			parse: async (text, options) => {
				seen.push({ text, suppress: options?.suppressErrors });
				return accepts(text) ? { diagramType: "x" } : false;
			},
			render: async () => ({ svg: "" })
		};
	};

	test("asks Mermaid to parse one sample per family, quietly", async () => {
		const api = fakeApi(() => true);
		expect(await supportedDiagrams(api)).toEqual([...DIAGRAM_KINDS]);
		expect(api.seen).toHaveLength(24);
		expect(api.seen.every((entry) => entry.suppress === true)).toBe(true);
	});

	test("lists only what the host build accepts", async () => {
		const api = fakeApi((text) => !/^(?:radar|venn|ishikawa|treemap|kanban)/.test(text));
		const supported = await supportedDiagrams(api);
		expect(supported).toContain("flowchart");
		["radar", "venn", "ishikawa", "treemap", "kanban"].forEach((kind) => expect(supported).not.toContain(kind));
		expect(supported).toHaveLength(19);
	});

	test("a build that throws instead of returning false counts as unsupported", async () => {
		const api: MermaidApi = {
			parse: async (text) => {
				if (text.startsWith("packet")) throw new Error("No diagram type detected");
				return { diagramType: "x" };
			},
			render: async () => ({ svg: "" })
		};
		const supported = await supportedDiagrams(api);
		expect(supported).not.toContain("packet");
		expect(supported).toContain("pie");
	});

	test("an older build with nothing registered yields an empty list", async () => {
		expect(await supportedDiagrams(fakeApi(() => false))).toEqual([]);
	});
});

describe("probe samples", () => {
	test.each(DIAGRAM_KINDS.map((kind) => [kind, PROBE_SOURCES[kind]] as const))("the %s sample names its own family", (kind, source) => {
		expect(detectKind(source)).toBe(kind as Kind);
	});

	test("covers every family exactly once", () => {
		expect(Object.keys(PROBE_SOURCES).sort()).toEqual([...DIAGRAM_KINDS].sort());
	});
});

describe("error helpers", () => {
	test("lineOf reads Mermaid's parse error shapes", () => {
		expect(lineOf({ hash: { loc: { first_line: 4 } } })).toBe(4);
		expect(lineOf({ hash: { line: 2 } })).toBe(3);
		expect(lineOf({ hash: {} })).toBeUndefined();
		expect(lineOf({ hash: "x" })).toBeUndefined();
		expect(lineOf(new Error("x"))).toBeUndefined();
		expect(lineOf(null)).toBeUndefined();
		expect(lineOf("text")).toBeUndefined();
	});

	test("errorText reads real errors, foreign-realm errors and strings", () => {
		expect(errorText(new Error("real"))).toBe("real");
		expect(errorText({ name: "Error", message: "from another window" })).toBe("from another window");
		expect(errorText("plain")).toBe("plain");
		expect(errorText(undefined)).toBe("Mermaid reported an error.");
		expect(errorText({ message: 5 })).toBe("Mermaid reported an error.");
	});

	test("firstLines keeps at most four non-empty lines, trimmed at the end", () => {
		expect(firstLines(new Error("a  \n\nb\nc\nd\ne\nf"))).toEqual(["a", "b", "c", "d"]);
		expect(firstLines(new Error("a\nb\nc"), 2)).toEqual(["a", "b"]);
		expect(firstLines(undefined)).toEqual(["Mermaid reported an error."]);
	});
});
