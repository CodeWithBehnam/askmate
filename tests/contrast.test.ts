import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Contrast checks for the AskMate colour tokens in styles.css (WCAG 2.2: 4.5:1 for text, 3:1 for UI and graphics).
 *
 * The tokens are read from styles.css itself, so a palette edit that breaks contrast fails here. They are checked
 * against Obsidian's default light and dark palettes, resolved from Obsidian's own app.css; AskMate never sets
 * surface or text colours, so these are the backgrounds its accents sit on.
 */

type Rgb = readonly [number, number, number];
type Theme = "light" | "dark";

const OBSIDIAN: Record<Theme, Record<"bg" | "bgAlt" | "bgSecondary" | "bgSecondaryAlt" | "text" | "muted", string>> = {
	light: { bg: "#ffffff", bgAlt: "#fafafa", bgSecondary: "#f6f6f6", bgSecondaryAlt: "#fcfcfc", text: "#222222", muted: "#5c5c5c" },
	dark: { bg: "#1c1c1c", bgAlt: "#232323", bgSecondary: "#282828", bgSecondaryAlt: "#333333", text: "#dadada", muted: "#b3b3b3" }
};

function parseHex(hex: string): Rgb {
	const digits = hex.replace("#", "");
	const full = digits.length === 3 ? digits.split("").map((c) => c + c).join("") : digits;
	const value = Number.parseInt(full, 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function channel(value: number): number {
	const srgb = value / 255;
	return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** color-mix(in srgb, fg amount%, bg): the same linear blend the stylesheet uses for tints. */
function mix(fg: Rgb, bg: Rgb, amount: number): Rgb {
	const blend = (index: 0 | 1 | 2): number => Math.round(fg[index] * amount + bg[index] * (1 - amount));
	return [blend(0), blend(1), blend(2)];
}

function readTokenBlocks(css: string): Record<Theme, Map<string, string>> {
	const light = new Map<string, string>();
	const dark = new Map<string, string>();
	for (const match of css.matchAll(/^body(\.theme-dark)?\s*\{([^}]*)\}/gm)) {
		const target = match[1] ? dark : light;
		for (const declaration of (match[2] ?? "").matchAll(/--askmate-([a-z0-9-]+):\s*([^;]+);/g)) {
			target.set(declaration[1] ?? "", (declaration[2] ?? "").trim());
		}
	}
	return { light, dark: new Map([...light, ...dark]) };
}

const stylesheet = readFileSync("styles.css", "utf8");
const tokens = readTokenBlocks(stylesheet);

/** The `--askmate-*` token a standalone top-level rule uses for one property, such as outline-color or background. */
function tokenUsedBy(selector: string, property: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const body = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(stylesheet)?.[1] ?? "";
	const token = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*var\\(--askmate-([a-z0-9-]+)\\)`).exec(body)?.[1];
	if (!token) {
		throw new Error(`${selector} has no ${property} that uses an --askmate-* token`);
	}
	return token;
}

function color(theme: Theme, name: string): Rgb {
	const value = tokens[theme].get(name);
	if (!value || !value.startsWith("#")) {
		throw new Error(`--askmate-${name} is not a hex colour in the ${theme} palette (found ${String(value)})`);
	}
	return parseHex(value);
}

function percent(theme: Theme, name: string): number {
	const value = tokens[theme].get(name);
	if (!value?.endsWith("%")) {
		throw new Error(`--askmate-${name} is not a percentage (found ${String(value)})`);
	}
	return Number.parseFloat(value) / 100;
}

function surfaces(theme: Theme): Array<[string, Rgb]> {
	const palette = OBSIDIAN[theme];
	return [
		["background-primary", parseHex(palette.bg)],
		["background-primary-alt", parseHex(palette.bgAlt)],
		["background-secondary", parseHex(palette.bgSecondary)],
		["background-secondary-alt", parseHex(palette.bgSecondaryAlt)]
	];
}

/** Backgrounds an accent can land on: the plain surfaces plus the brand tints mixed into them. */
function accentBackgrounds(theme: Theme): Array<[string, Rgb]> {
	const brand = color(theme, "brand");
	const tinted = surfaces(theme).filter(([name]) => name !== "background-secondary-alt").flatMap(([name, rgb]): Array<[string, Rgb]> => [
		[`${name} + tint-1`, mix(brand, rgb, percent(theme, "tint-1"))],
		[`${name} + tint-2`, mix(brand, rgb, percent(theme, "tint-2"))]
	]);
	return [...surfaces(theme), ...tinted];
}

const THEMES: Theme[] = ["light", "dark"];

describe("brand token set", () => {
	test("both palettes define every token the stylesheet relies on", () => {
		const required = ["brand", "brand-hover", "on-brand", "accent", "mint", "focus", "success", "warning", "danger", "on-danger", "series-2", "tint-1", "tint-2", "tint-3"];
		for (const theme of THEMES) {
			for (const name of required) {
				expect(tokens[theme].has(name), `--askmate-${name} missing from the ${theme} palette`).toBe(true);
			}
		}
	});

	test("the palette matches the owner decision for the Mate Mark brand", () => {
		expect(tokens.light.get("brand")).toBe("#352fa0");
		expect(tokens.dark.get("brand")).toBe("#9c98ff");
		expect(tokens.light.get("accent")).toBe("#0a7558");
		expect(tokens.dark.get("accent")).toBe("#7ee8c6");
		expect(tokens.light.get("mint")).toBe("#46d9b0");
		expect(tokens.dark.get("mint")).toBe("#7ee8c6");
		expect(tokens.light.get("success")).toBe("#0f7b49");
		expect(tokens.dark.get("success")).toBe("#5be08f");
		expect(tokens.light.get("warning")).toBe("#b45309");
		expect(tokens.dark.get("warning")).toBe("#fbbf24");
		expect(tokens.light.get("danger")).toBe("#c62828");
		expect(tokens.dark.get("danger")).toBe("#ff8a80");
	});
});

describe("text contrast (4.5:1)", () => {
	for (const theme of THEMES) {
		test(`${theme}: brand and accent text on every surface and tint`, () => {
			for (const [label, background] of accentBackgrounds(theme)) {
				expect(contrast(color(theme, "brand"), background), `brand on ${label}`).toBeGreaterThanOrEqual(4.5);
				// The mint accent is only ever placed on plain surfaces and the faintest tint, never on the stronger selected-state tint.
				if (!label.endsWith("tint-2")) {
					expect(contrast(color(theme, "accent"), background), `accent on ${label}`).toBeGreaterThanOrEqual(4.5);
				}
			}
		});

		test(`${theme}: status text on every surface, and status glyphs on their own tint`, () => {
			for (const name of ["success", "warning", "danger"]) {
				const rgb = color(theme, name);
				for (const [label, background] of surfaces(theme)) {
					expect(contrast(rgb, background), `${name} on ${label}`).toBeGreaterThanOrEqual(4.5);
					// Glyphs (check, bang, cross) sit on the status colour's own faint tint; status text itself stays neutral, so 3:1 applies there.
					expect(contrast(rgb, mix(rgb, background, percent(theme, "tint-1"))), `${name} glyph on ${name} tint over ${label}`).toBeGreaterThanOrEqual(3);
				}
			}
		});

		test(`${theme}: Obsidian text and muted text stay readable on the warning and danger tints`, () => {
			// A pending or failed tool card, a changed-tool notice, a failed diagram and every warning callout sit on these tints.
			const palette = OBSIDIAN[theme];
			for (const name of ["warning", "danger"]) {
				for (const [label, surface] of surfaces(theme)) {
					const tinted = mix(color(theme, name), surface, percent(theme, "tint-1"));
					expect(contrast(parseHex(palette.text), tinted), `text-normal on the ${name} tint over ${label}`).toBeGreaterThanOrEqual(4.5);
					expect(contrast(parseHex(palette.muted), tinted), `text-muted on the ${name} tint over ${label}`).toBeGreaterThanOrEqual(4.5);
				}
			}
		});

		test(`${theme}: the danger colour reads as text on its own tint, where a failed tool call shows its error`, () => {
			const danger = color(theme, "danger");
			for (const [label, surface] of surfaces(theme)) {
				expect(contrast(danger, mix(danger, surface, percent(theme, "tint-1"))), `danger on the danger tint over ${label}`).toBeGreaterThanOrEqual(4.5);
			}
		});

		test(`${theme}: text on filled buttons`, () => {
			expect(contrast(color(theme, "on-brand"), color(theme, "brand"))).toBeGreaterThanOrEqual(4.5);
			expect(contrast(color(theme, "on-brand"), color(theme, "brand-hover"))).toBeGreaterThanOrEqual(4.5);
			expect(contrast(color(theme, "on-danger"), color(theme, "danger"))).toBeGreaterThanOrEqual(4.5);
		});

		test(`${theme}: Obsidian text and muted text stay readable on the brand tints`, () => {
			const palette = OBSIDIAN[theme];
			for (const [label, background] of accentBackgrounds(theme)) {
				expect(contrast(parseHex(palette.text), background), `text-normal on ${label}`).toBeGreaterThanOrEqual(4.5);
				expect(contrast(parseHex(palette.muted), background), `text-muted on ${label}`).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});

describe("UI contrast (3:1)", () => {
	for (const theme of THEMES) {
		test(`${theme}: the focus ring is visible on every surface and tint`, () => {
			for (const [label, background] of accentBackgrounds(theme)) {
				expect(contrast(color(theme, "focus"), background), `focus ring on ${label}`).toBeGreaterThanOrEqual(3);
			}
		});

		test(`${theme}: the focus ring on the filled console buttons contrasts with their own fill`, () => {
			// The inward ring is drawn on the button's fill, not on the theme surface, so the surface checks above do not cover it.
			const filled = [
				{ name: "mode button", ring: ".askmate-sidebar .askmate-console-status .askmate-console-segment.is-mode:focus-visible", fill: ".askmate-sidebar .askmate-console-segment.is-mode" },
				{ name: "stop button", ring: ".askmate-sidebar .askmate-console-status .askmate-console-stop:focus-visible", fill: ".askmate-sidebar .askmate-console-stop" }
			];
			for (const { name, ring, fill } of filled) {
				const ringToken = tokenUsedBy(ring, "outline-color");
				const fillToken = tokenUsedBy(fill, "background");
				expect(ringToken, `${name} ring is not the fill colour`).not.toBe(fillToken);
				expect(contrast(color(theme, ringToken), color(theme, fillToken)), `${name} ring (${ringToken}) on its fill (${fillToken})`).toBeGreaterThanOrEqual(3);
			}
		});

		test(`${theme}: chart series and meter fills are visible on the surfaces`, () => {
			for (const name of ["brand", "series-2", "success", "warning", "danger"]) {
				for (const [label, background] of surfaces(theme)) {
					expect(contrast(color(theme, name), background), `${name} on ${label}`).toBeGreaterThanOrEqual(3);
				}
			}
		});
	}

	test("dark: the mint graphic is visible on the dark surfaces", () => {
		for (const [label, background] of surfaces("dark")) {
			expect(contrast(color("dark", "mint"), background), `mint on ${label}`).toBeGreaterThanOrEqual(3);
		}
	});

	test("light: the graphic mint is never the only carrier of text, so the text-safe accent is used instead", () => {
		const graphicMint = contrast(color("light", "mint"), parseHex(OBSIDIAN.light.bg));
		expect(graphicMint, "light mint is a graphic-only colour").toBeLessThan(3);
		expect(contrast(color("light", "accent"), parseHex(OBSIDIAN.light.bg))).toBeGreaterThanOrEqual(4.5);
	});
});

describe("contrast helper", () => {
	test("matches the WCAG reference values", () => {
		expect(contrast(parseHex("#000000"), parseHex("#ffffff"))).toBeCloseTo(21, 5);
		expect(contrast(parseHex("#777777"), parseHex("#ffffff"))).toBeCloseTo(4.48, 1);
		expect(contrast(parseHex("#fff"), parseHex("#fff"))).toBeCloseTo(1, 5);
	});

	test("mix blends towards the foreground by the given amount", () => {
		expect(mix([0, 0, 0], [255, 255, 255], 0.5)).toEqual([128, 128, 128]);
		expect(mix([10, 20, 30], [200, 200, 200], 0)).toEqual([200, 200, 200]);
	});
});
