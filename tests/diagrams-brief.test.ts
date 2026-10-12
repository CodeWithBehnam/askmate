import { describe, expect, test } from "bun:test";
import { buildDiagramBrief } from "../src/diagrams/brief";
import { contrast } from "../src/diagrams/color";
import { CLASSDEF_KINDS, KIND_KEYWORDS } from "../src/diagrams/header";
import { makePalette, ROLES } from "../src/diagrams/palette";
import { DENSITY_PADDING, designFromRecipe, findRecipe, noteSeed, recipeOrder, STYLE_RECIPES } from "../src/diagrams/recipes";
import { DIAGRAM_KINDS, type StyleRecipe } from "../src/diagrams/types";
import { MERMAID_DIAGRAMS_SKILL } from "../src/skills";

const HEADINGS = ["Goals", "Plan", "Risks"];
const brief = (nonce: number, title = "Projects/Roadmap", headings: readonly string[] = HEADINGS) => buildDiagramBrief({ title, headings, nonce });

/** Mermaid 11.13 blanks a themeVariables string outside this set, so a recipe font must stay inside it. */
const MERMAID_SAFE_VALUE = /^[\d "#%(),.;A-Za-z]+$/;

describe("buildDiagramBrief", () => {
	test("is reproducible for the same title, headings and nonce", () => {
		expect(brief(0)).toEqual(brief(0));
		expect(brief(3).text).toBe(brief(3).text);
		expect(JSON.stringify(brief(5).design)).toBe(JSON.stringify(brief(5).design));
	});

	test("differs for a new nonce", () => {
		for (let nonce = 0; nonce < 40; nonce += 1) {
			expect(JSON.stringify(brief(nonce).design)).not.toBe(JSON.stringify(brief(nonce + 1).design));
		}
	});

	test("eight consecutive re-rolls visit all eight recipes before any repeats", () => {
		const ids = Array.from({ length: 8 }, (_, nonce) => brief(nonce).recipe.id);
		expect(new Set(ids).size).toBe(8);
		expect(brief(8).recipe.id).toBe(brief(0).recipe.id);
	});

	test("depends on the note: other titles and headings walk the recipes in another order", () => {
		const orders = ["Daily/2026-10-12", "Projects/Roadmap", "Ideas", "Reading list", "Meeting notes"].map((title) => recipeOrder(noteSeed(title, HEADINGS)).map((recipe) => recipe.id).join(","));
		expect(new Set(orders).size).toBeGreaterThan(2);
		expect(noteSeed("Ideas", ["A"])).not.toBe(noteSeed("Ideas", ["B"]));
		expect(noteSeed("  Ideas ", [" A "])).toBe(noteSeed("Ideas", ["A"]));
	});

	test("the same recipe on two notes still looks different", () => {
		const first = STYLE_RECIPES[3] as StyleRecipe;
		expect(designFromRecipe(first, 100 << 8).hue).not.toBe(designFromRecipe(first, 7 << 8).hue);
	});

	test("every design is usable by Mermaid: integer hue in range, a positive hand-drawn seed, known padding", () => {
		for (let i = 0; i < 400; i += 1) {
			const { design } = brief(i, `Note ${i}`, [`Heading ${i}`]);
			expect(Number.isInteger(design.hue)).toBe(true);
			expect(design.hue).toBeGreaterThanOrEqual(0);
			expect(design.hue).toBeLessThan(360);
			expect(design.seed).toBeGreaterThanOrEqual(1);
			expect(Number.isInteger(design.seed)).toBe(true);
			expect(Object.values(DENSITY_PADDING)).toContain(design.padding as number);
		}
	});

	test("every design the brief can produce keeps the contrast guarantees", () => {
		const failures: string[] = [];
		for (let i = 0; i < 200; i += 1) {
			const { design } = brief(i, `Note ${i}`, []);
			const palette = makePalette(design.hue, design.mood, design.accentOffset);
			ROLES.forEach((role) => {
				if (contrast(palette[role].text, palette[role].fill) < 7) failures.push(`${i} ${role}`);
			});
		}
		expect(failures).toEqual([]);
	});

	test("tolerates odd nonces", () => {
		[-1, -9, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN].forEach((nonce) => {
			expect(() => brief(nonce)).not.toThrow();
			expect(STYLE_RECIPES.map((recipe) => recipe.id)).toContain(brief(nonce).recipe.id);
		});
	});

	test("the text block names the look, the roles and the first line, and carries no note content", () => {
		const { text, recipe } = brief(0, "Secret title", ["Secret heading"]);
		expect(text.startsWith("<diagram_brief>")).toBe(true);
		expect(text.endsWith("</diagram_brief>")).toBe(true);
		expect(text).toContain(`Look: ${recipe.name}.`);
		ROLES.forEach((role) => expect(text).toContain(`- ${role}:`));
		expect(text).not.toContain("Secret");
		expect(text).toContain("Never write frontmatter, %% directives or classDef lines");
	});

	test("lists only the supported families, or the one the user picked", () => {
		const open = buildDiagramBrief({ title: "t", headings: [], nonce: 0 });
		DIAGRAM_KINDS.forEach((kind) => expect(open.text).toContain(KIND_KEYWORDS[kind]));
		const limited = buildDiagramBrief({ title: "t", headings: [], nonce: 0, supported: ["flowchart", "pie"] });
		expect(limited.text).toContain("flowchart TD (or LR), pie");
		expect(limited.text).not.toContain("sequenceDiagram");
		const chosen = buildDiagramBrief({ title: "t", headings: [], nonce: 0, kind: "state" });
		expect(chosen.text).toContain("First line: stateDiagram-v2");
		expect(chosen.text).not.toContain("pick the one that fits");
	});

	test("does not ask for a chosen family this build cannot draw: it falls back to the supported list", () => {
		const unsupported = buildDiagramBrief({ title: "t", headings: [], nonce: 0, kind: "venn", supported: ["flowchart", "sequence"] });
		expect(unsupported.text).not.toContain("venn");
		expect(unsupported.text).toContain("pick the one that fits the content best");
		expect(unsupported.text).toContain("First line is one of: flowchart TD (or LR), sequenceDiagram");
		const supported = buildDiagramBrief({ title: "t", headings: [], nonce: 0, kind: "sequence", supported: ["flowchart", "sequence"] });
		expect(supported.text).toContain("Diagram type: draw a sequence diagram. First line: sequenceDiagram");
	});

	test("Auto yields to a type the request names and to a fix, which keeps its own type, as the skill says", () => {
		const { text } = buildDiagramBrief({ title: "t", headings: [], nonce: 0 });
		expect(text).toContain("unless the request names a type or asks you to fix, restyle or extend a diagram, which keeps its own type");
	});

	test("is the one place for role meanings and the roles cap, and the diagram skill points here instead of repeating them", () => {
		const { text } = buildDiagramBrief({ title: "t", headings: [], nonce: 0 });
		expect(text).toContain("Use at most three roles in one diagram and one role per meaning.");
		expect(text).toContain("- accent: the one decision, hand-off or key idea to notice");
		expect(text).toContain("- ink: a start, an end or an outside actor");
		expect(MERMAID_DIAGRAMS_SKILL.body).not.toContain("a start, an end or an outside actor");
		expect(MERMAID_DIAGRAMS_SKILL.body).not.toMatch(/\bat most three roles\b/i);
	});

	test("lists as taggable exactly the families the plugin writes classDef lines for", () => {
		const { text } = buildDiagramBrief({ title: "t", headings: [], nonce: 0 });
		const tagging = text.split("\n").find((line) => line.startsWith("Tags work in")) ?? "";
		expect(tagging).not.toBe("");
		DIAGRAM_KINDS.forEach((kind) => {
			const named = tagging.includes(KIND_KEYWORDS[kind]);
			expect({ kind, named }).toEqual({ kind, named: CLASSDEF_KINDS.has(kind) });
		});
	});
});

describe("style recipes", () => {
	test("there are the eight named looks", () => {
		expect(STYLE_RECIPES.map((recipe) => recipe.name)).toEqual(["Blueprint", "Sketchbook", "Editorial Ink", "Sunrise", "Lagoon", "Grape Soda", "Slate", "Terminal"]);
		expect(new Set(STYLE_RECIPES.map((recipe) => recipe.id)).size).toBe(8);
		STYLE_RECIPES.forEach((recipe) => expect(findRecipe(recipe.id)).toBe(recipe));
		expect(findRecipe("missing")).toBeUndefined();
	});

	test("never uses a named Mermaid theme or the ELK layout", () => {
		expect(JSON.stringify(STYLE_RECIPES).toLowerCase()).not.toMatch(/forest|neutral|redux|\bneo\b|\belk\b|"dark"/);
		STYLE_RECIPES.forEach((recipe) => expect(["classic", "handDrawn"]).toContain(recipe.look));
	});

	test("every pair differs in at least two of look, font, curve, palette family and density", () => {
		const family = (recipe: StyleRecipe): string => `${recipe.mood}`;
		const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
		const failures: string[] = [];
		STYLE_RECIPES.forEach((a, i) => {
			STYLE_RECIPES.slice(i + 1).forEach((b) => {
				const differences = [
					a.look !== b.look,
					(a.font?.family ?? "") !== (b.font?.family ?? ""),
					a.curve !== b.curve,
					family(a) !== family(b) || hueGap(a.hue, b.hue) >= 40,
					a.density !== b.density
				].filter(Boolean).length;
				if (differences < 2) failures.push(`${a.name} and ${b.name}: ${differences}`);
			});
		});
		expect(failures).toEqual([]);
	});

	test("every font stack survives Mermaid's themeVariables sanitiser", () => {
		STYLE_RECIPES.forEach((recipe) => {
			if (recipe.font === undefined) return;
			expect(recipe.font.family).toMatch(MERMAID_SAFE_VALUE);
			expect(recipe.font.size).toMatch(MERMAID_SAFE_VALUE);
		});
	});

	test("the descriptions are plain sentences for the style picker", () => {
		STYLE_RECIPES.forEach((recipe) => {
			expect(recipe.description.length).toBeGreaterThan(20);
			expect(recipe.description.endsWith(".")).toBe(true);
			expect(recipe.description).not.toContain(String.fromCharCode(0x2014));
		});
	});

	test("the hand-drawn recipe is the only one with the hand-drawn look", () => {
		expect(STYLE_RECIPES.filter((recipe) => recipe.look === "handDrawn").map((recipe) => recipe.id)).toEqual(["sketchbook"]);
	});
});
