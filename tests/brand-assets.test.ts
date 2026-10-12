import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { ASKMATE_ICON_SVG } from "../src/brand/icons";

/*
 * Guards for the Mate Mark brand assets: they exist, are well-formed, safe to embed in a GitHub README, built only from
 * the approved palette, and the Obsidian icon is the same geometry as the logo mark.
 */

const ASSETS = [
	"logo-mark.svg",
	"logo-mark-dark.svg",
	"logo-light.svg",
	"logo-dark.svg",
	"hero-light.svg",
	"hero-dark.svg",
	"social-preview.svg"
] as const;

function read(name: string): string {
	return readFileSync(`assets/${name}`, "utf8");
}

/** The owner-approved palette (decision 1) plus the tones derived from it for gradients, panels and diagram strokes. */
const PALETTE = new Set(
	[
		// Brand, surfaces, text and status from the owner decision.
		"#352FA0", "#9C98FF", "#7EE8C6", "#0A7558", "#46D9B0", "#F6F7FB", "#FFFFFF", "#DFE2EE", "#0D0E26", "#15173B", "#272A57",
		"#14162F", "#565C7B", "#EDEFFC", "#A5A9C9", "#0F7B49", "#5BE08F", "#B45309", "#FBBF24", "#C62828", "#FF8A80",
		// Mark tones on light and on dark.
		"#4640C8", "#2B2791", "#8F8BFF", "#5E58E0",
		// Derived: banner gradient ends, panel fills and strokes, tinted bubbles, diagram strokes and arrows, shadow flood.
		"#15123F", "#12143A", "#2A2D5E", "#2A2670", "#4A45B0", "#3A3E78", "#8387AD", "#E9EBF7", "#B9BCDA", "#7A7FA3", "#E4E3FB", "#C4C1F2", "#000000"
	].map((hex) => hex.toUpperCase())
);

/** A minimal well-formedness check: tags nest and close. Comments, declarations and self-closing tags are skipped. */
function isBalanced(xml: string): boolean {
	const stack: string[] = [];
	for (const match of xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z][\w:-]*)\b[^>]*?(\/?)>/g)) {
		const [, closing, name, selfClosing] = match;
		if (selfClosing || !name) {
			continue;
		}
		if (closing) {
			if (stack.pop() !== name) {
				return false;
			}
		} else {
			stack.push(name);
		}
	}
	return stack.length === 0;
}

describe("brand assets", () => {
	for (const name of ASSETS) {
		describe(name, () => {
			test("exists and is well-formed SVG with an accessible name", () => {
				expect(existsSync(`assets/${name}`)).toBe(true);
				const svg = read(name);
				expect(svg.startsWith("<svg ")).toBe(true);
				expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
				expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
				expect(isBalanced(svg)).toBe(true);
				expect(svg).toMatch(/<title id="title">[^<]+<\/title>/);
				expect(svg).toMatch(/<desc id="desc">[^<]+<\/desc>/);
			});

			test("is safe to embed: no script, handlers, remote references or embedded raster images", () => {
				const svg = read(name);
				expect(svg).not.toMatch(/<script|<foreignObject|<image|<style|@import|@font-face/i);
				expect(svg).not.toMatch(/\son[a-z]+=/i);
				expect(svg).not.toMatch(/(?:href|src)=["']https?:/i);
				expect(svg).not.toMatch(/url\(\s*["']?(?!#)/i);
			});

			test("uses only palette colours", () => {
				const used = new Set((read(name).match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((hex) => hex.toUpperCase()));
				const stray = [...used].filter((hex) => !PALETTE.has(hex));
				expect(stray).toEqual([]);
			});

			test("names a system fallback for every font, because GitHub does not load web fonts inside an img", () => {
				const families = [...read(name).matchAll(/font-family="([^"]+)"/g)].map((match) => match[1] ?? "");
				for (const family of families) {
					expect(family).toMatch(/\b(?:sans-serif|monospace)\b/);
				}
			});
		});
	}

	test("the hero and social preview are 1280 by 640", () => {
		for (const name of ["hero-light.svg", "hero-dark.svg", "social-preview.svg"]) {
			expect(read(name)).toContain('width="1280" height="640" viewBox="0 0 1280 640"');
		}
	});

	test("the logo and mark are square or wide enough to be used as a README header", () => {
		expect(read("logo-mark.svg")).toContain('viewBox="0 0 100 100"');
		expect(read("logo-light.svg")).toMatch(/viewBox="0 0 372 96"/);
	});

	test("light and dark variants use the right wordmark colour for their surface", () => {
		expect(read("logo-light.svg")).toContain('fill="#14162F">AskMate</text>');
		expect(read("logo-dark.svg")).toContain('fill="#EDEFFC">AskMate</text>');
	});

	test("the light mark uses the light-surface tones and the dark mark the lifted tones", () => {
		for (const hex of ["#4640C8", "#2B2791", "#46D9B0"]) {
			expect(read("logo-mark.svg")).toContain(hex);
			expect(read("logo-mark-dark.svg")).not.toContain(hex);
		}
		for (const hex of ["#8F8BFF", "#5E58E0", "#7EE8C6"]) {
			expect(read("logo-mark-dark.svg")).toContain(hex);
			expect(read("logo-mark.svg")).not.toContain(hex);
		}
	});

	test("the hero shows the real product vocabulary rather than placeholder bars", () => {
		for (const name of ["hero-light.svg", "hero-dark.svg"]) {
			const svg = read(name);
			for (const phrase of ["Valid", "flowchart", "Needs approval", "Allow once", "Allow for this chat", "Deny", "Skill: Mermaid diagrams", "Insert", "Another look"]) {
				expect(svg, `${name} shows "${phrase}"`).toContain(phrase);
			}
		}
	});
});

describe("Obsidian icon", () => {
	const pathData = /d="([^"]+)"/.exec(ASKMATE_ICON_SVG)?.[1] ?? "";

	function mainPathData(name: string, id: string): string {
		return new RegExp(`<clipPath id="${id}-crown"><path d="([^"]+)"/></clipPath>`).exec(read(name))?.[1] ?? "";
	}

	test("is one filled currentColor path with no stroke, so Obsidian's icon stroke cannot close the gaps", () => {
		expect(ASKMATE_ICON_SVG.match(/<path /g)?.length).toBe(1);
		expect(ASKMATE_ICON_SVG).toContain('fill="currentColor"');
		expect(ASKMATE_ICON_SVG).toContain('stroke="none"');
		expect(ASKMATE_ICON_SVG).not.toMatch(/#[0-9a-f]{3,6}/i);
	});

	test("keeps every endpoint inside the 100 by 100 canvas", () => {
		const commands = pathData.match(/[MLAZ][^MLAZ]*/g) ?? [];
		expect(commands.length).toBeGreaterThan(20);
		for (const command of commands) {
			const numbers = (command.slice(1).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
			const [x, y] = command[0] === "A" ? [numbers[5], numbers[6]] : [numbers[0], numbers[1]];
			if (command[0] === "Z") {
				continue;
			}
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(100);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(100);
		}
	});

	test("is the same geometry as the logo mark: crown, bubble and two feet", () => {
		const svg = read("logo-mark.svg");
		const crown = mainPathData("logo-mark.svg", "m");
		const others = [...svg.matchAll(/<path d="([^"]+)" fill="#[0-9A-F]{6}"\/>/g)].map((match) => match[1] ?? "");
		expect(crown).not.toBe("");
		expect(others).toHaveLength(3);
		expect(`${crown}${others.join("")}`).toBe(pathData);
	});
});
