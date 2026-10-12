// Deterministic palettes. Every colour is a hex string because Mermaid ignores colour names and CSS variables in themeVariables.

import { contrast, hslToHex, luminance } from "./color";
import type { FontSpec, Mood, Palette, Role, RoleColours } from "./types";

interface MoodSpec {
	readonly s: number;
	readonly fill: number;
	readonly stroke: number;
	readonly text: number;
	readonly soft: number;
}

const MOODS: Readonly<Record<Mood, MoodSpec>> = {
	pastel: { s: 78, fill: 94, stroke: 42, text: 17, soft: 97 },
	vivid: { s: 88, fill: 89, stroke: 36, text: 14, soft: 95 },
	muted: { s: 28, fill: 94, stroke: 40, text: 18, soft: 97 },
	ink: { s: 6, fill: 98, stroke: 12, text: 10, soft: 94 }
};

export const ROLES: readonly Role[] = ["primary", "accent", "success", "warn", "danger", "muted", "ink"];

/** Lightness floor for the darkening loops. Below this the colour is effectively black and cannot improve. */
const LIGHTNESS_FLOOR = 12;
const GOLDEN_ANGLE = 137.508;

/** Darkens a colour in steps of two lightness points until it reaches `min` contrast against `against`. */
function darkenToContrast(hue: number, saturation: number, startLightness: number, against: string, min: number): string {
	const at = (lightness: number): string => hslToHex(hue, saturation, lightness);
	let lightness = startLightness;
	while (contrast(at(lightness), against) < min && lightness > LIGHTNESS_FLOOR) {
		lightness -= 2;
	}
	return at(lightness);
}

function role(hue: number, mood: MoodSpec): RoleColours {
	const fill = hslToHex(hue, mood.s, mood.fill);
	return {
		fill,
		stroke: darkenToContrast(hue, mood.s * 0.85, mood.stroke, fill, 3.2),
		text: darkenToContrast(hue, mood.s * 0.7, mood.text, fill, 7)
	};
}

/** Label text is at least 7:1 and strokes are at least 3.2:1 on their fills for every hue and mood (swept in steps of 5 degrees). */
export function makePalette(hue: number, mood: Mood, accentOffset = 150): Palette {
	const spec = MOODS[mood];
	const mutedFill = hslToHex(hue, 8, 95);
	return {
		primary: role(hue, spec),
		accent: role(hue + accentOffset, spec),
		success: role(145, spec),
		warn: role(38, { ...spec, s: Math.max(spec.s, 60) }),
		danger: role(4, { ...spec, s: Math.max(spec.s, 60) }),
		muted: {
			fill: mutedFill,
			stroke: darkenToContrast(hue, 8, 62, mutedFill, 3.2),
			text: darkenToContrast(hue, 8, 34, mutedFill, 7)
		},
		ink: { fill: hslToHex(hue, 30, 12), stroke: hslToHex(hue, 30, 12), text: "#f8fafc" },
		soft: hslToHex(hue, spec.s * 0.6, spec.soft),
		line: hslToHex(hue, spec.s * 0.8, 34)
	};
}

/** Categorical marks for pie, bar, timeline and radar, spaced by the golden angle. White text on every mark reaches at least 4.6:1. */
export function marks(hue: number, count = 12, saturation = 62): readonly string[] {
	return Array.from({ length: count }, (_, i) => {
		const h = hue + i * GOLDEN_ANGLE;
		let lightness = 46;
		while (contrast(hslToHex(h, saturation, lightness), "#ffffff") < 4.6 && lightness > 20) {
			lightness -= 2;
		}
		return hslToHex(h, saturation, lightness);
	});
}

/** Soft fills that keep dark text readable, for kanban cards and journey sections. */
export function softMarks(hue: number, count: number, saturation = 70, lightness = 82): readonly string[] {
	return Array.from({ length: count }, (_, i) => hslToHex(hue + i * GOLDEN_ANGLE, saturation, lightness));
}

/**
 * Mindmap labels inherit the app text colour, and Obsidian inverts diagrams in dark mode, so the label flips.
 * Fills near relative luminance 0.2 keep both near-black and near-white labels readable (about 3.5:1).
 */
export function balancedMarks(hue: number, count = 12, saturation = 66, target = 0.2): readonly string[] {
	return Array.from({ length: count }, (_, i) => {
		const h = hue + i * GOLDEN_ANGLE;
		let lo = 15;
		let hi = 90;
		for (let step = 0; step < 14; step += 1) {
			const mid = (lo + hi) / 2;
			if (luminance(hslToHex(h, saturation, mid)) < target) lo = mid;
			else hi = mid;
		}
		return hslToHex(h, saturation, (lo + hi) / 2);
	});
}

/** The classDef lines the plugin appends so the model only has to tag nodes with a role name. */
export function classDefLines(palette: Palette): string {
	return ROLES.map((name) => {
		const colours = palette[name];
		const tail = name === "muted" ? "stroke-dasharray:4 3" : "stroke-width:2px";
		return `classDef ${name} fill:${colours.fill},stroke:${colours.stroke},color:${colours.text},${tail}`;
	}).join("\n");
}

/** Core themeVariables shared by every diagram type. Per-type extras are layered on top by typeExtras. */
export function baseThemeVariables(palette: Palette, font?: FontSpec): Record<string, string> {
	return {
		primaryColor: palette.primary.fill,
		primaryTextColor: palette.primary.text,
		primaryBorderColor: palette.primary.stroke,
		secondaryColor: palette.accent.fill,
		secondaryTextColor: palette.accent.text,
		secondaryBorderColor: palette.accent.stroke,
		tertiaryColor: palette.soft,
		tertiaryTextColor: palette.primary.text,
		tertiaryBorderColor: palette.primary.stroke,
		lineColor: palette.line,
		textColor: palette.primary.text,
		edgeLabelBackground: "#ffffff",
		...(font ? { fontFamily: font.family, fontSize: font.size } : {})
	};
}
