import { describe, expect, test } from "bun:test";
import { contrast, fnv1a, hslToHex, hueFromSeed, luminance } from "../src/diagrams/color";
import { balancedMarks, baseThemeVariables, classDefLines, makePalette, marks, ROLES, softMarks } from "../src/diagrams/palette";
import type { Mood } from "../src/diagrams/types";

const MOODS: readonly Mood[] = ["pastel", "vivid", "muted", "ink"];
const HEX = /^#[0-9a-f]{6}$/;
const hues = Array.from({ length: 72 }, (_, i) => i * 5);

describe("colour maths", () => {
	test("hslToHex returns the primaries and wraps the hue", () => {
		expect(hslToHex(0, 100, 50)).toBe("#ff0000");
		expect(hslToHex(120, 100, 50)).toBe("#00ff00");
		expect(hslToHex(240, 100, 50)).toBe("#0000ff");
		expect(hslToHex(0, 0, 100)).toBe("#ffffff");
		expect(hslToHex(0, 0, 0)).toBe("#000000");
		expect(hslToHex(-120, 100, 50)).toBe(hslToHex(240, 100, 50));
		expect(hslToHex(480, 100, 50)).toBe(hslToHex(120, 100, 50));
		expect(hslToHex(10, 500, 50)).toBe(hslToHex(10, 100, 50));
	});

	test("contrast follows WCAG", () => {
		expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
		expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
		expect(luminance("#ffffff")).toBeCloseTo(1, 5);
		expect(luminance("#000000")).toBe(0);
	});

	test("fnv1a matches the published 32-bit test vectors", () => {
		expect(fnv1a("")).toBe(0x811c9dc5);
		expect(fnv1a("a")).toBe(0xe40c292c);
		expect(fnv1a("foobar")).toBe(0xbf9cf968);
	});

	test("the seed is deterministic and spreads", () => {
		expect(hueFromSeed("Projects/Roadmap.md")).toBe(hueFromSeed("Projects/Roadmap.md"));
		expect(new Set(["a", "b", "c", "d", "e", "f"].map(hueFromSeed)).size).toBeGreaterThan(4);
		hues.forEach((_, i) => expect(hueFromSeed(`note ${i}`)).toBeLessThan(360));
	});
});

describe("palette sweep", () => {
	test("label text is at least 7:1 and strokes at least 3.2:1 on their fills, for every hue, mood and accent offset", () => {
		const failures: string[] = [];
		for (const mood of MOODS) {
			for (const hue of hues) {
				for (const offset of [0, 130, 150, 180]) {
					const palette = makePalette(hue, mood, offset);
					for (const role of ROLES) {
						const { fill, stroke, text } = palette[role];
						[fill, stroke, text].forEach((value) => {
							if (!HEX.test(value)) failures.push(`${mood} ${hue} ${role}: ${value} is not hex`);
						});
						if (contrast(text, fill) < 7) failures.push(`${mood} ${hue}+${offset} ${role} text ${contrast(text, fill).toFixed(2)}`);
						if (role !== "ink" && contrast(stroke, fill) < 3.2) failures.push(`${mood} ${hue}+${offset} ${role} stroke ${contrast(stroke, fill).toFixed(2)}`);
					}
					[palette.soft, palette.line].forEach((value) => expect(value).toMatch(HEX));
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("the connector line is visible against white for every hue and mood", () => {
		const failures = MOODS.flatMap((mood) => hues.filter((hue) => contrast(makePalette(hue, mood).line, "#ffffff") < 3).map((hue) => `${mood} ${hue}`));
		expect(failures).toEqual([]);
	});

	test("white text on every categorical mark is at least 4.6:1, for every hue", () => {
		const failures = hues.flatMap((hue) => marks(hue, 12).filter((mark) => contrast("#ffffff", mark) < 4.6).map((mark) => `${hue} ${mark}`));
		expect(failures).toEqual([]);
		expect(marks(10, 5)).toHaveLength(5);
		marks(10).forEach((mark) => expect(mark).toMatch(HEX));
	});

	test("marks are distinct neighbours", () => {
		hues.forEach((hue) => expect(new Set(marks(hue, 12)).size).toBe(12));
	});

	test("balanced marks stay readable with both a near-black and a near-white label", () => {
		const failures = hues.flatMap((hue) =>
			balancedMarks(hue).filter((mark) => contrast("#1a1a1a", mark) < 3 || contrast("#f2f2f2", mark) < 2.8).map((mark) => `${hue} ${mark}`)
		);
		expect(failures).toEqual([]);
	});

	test("soft marks keep dark text readable", () => {
		hues.forEach((hue) => softMarks(hue, 8).forEach((mark) => expect(contrast("#152832", mark)).toBeGreaterThan(7)));
	});
});

describe("palette outputs", () => {
	test("classDef lines name every role once, with hex colours", () => {
		const lines = classDefLines(makePalette(210, "vivid", 140)).split("\n");
		expect(lines).toHaveLength(ROLES.length);
		lines.forEach((line, i) => {
			expect(line).toMatch(new RegExp(`^classDef ${ROLES[i]} fill:#[0-9a-f]{6},stroke:#[0-9a-f]{6},color:#[0-9a-f]{6},(stroke-width:2px|stroke-dasharray:4 3)$`));
		});
		expect(lines.filter((line) => line.includes("stroke-dasharray"))).toHaveLength(1);
	});

	test("base theme variables are hex, with a font only when asked", () => {
		const plain = baseThemeVariables(makePalette(10, "pastel"));
		Object.values(plain).forEach((value) => expect(value).toMatch(HEX));
		expect("fontFamily" in plain).toBe(false);
		const withFont = baseThemeVariables(makePalette(10, "pastel"), { family: "Menlo, monospace", size: "13px" });
		expect(withFont.fontFamily).toBe("Menlo, monospace");
		expect(withFont.fontSize).toBe("13px");
	});
});
