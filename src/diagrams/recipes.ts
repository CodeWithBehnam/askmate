// Eight named looks. Each one differs from every other in at least two of look, font, connector curve, palette family and density.

import { fnv1a } from "./color";
import type { Density, Design, FontSpec, StyleRecipe } from "./types";

const MONO: FontSpec = { family: "Menlo, Monaco, Consolas, Courier New, monospace", size: "13px" };
const SERIF: FontSpec = { family: "Georgia, Times New Roman, serif", size: "15px" };
const HAND: FontSpec = { family: "Segoe Print, Bradley Hand, Chalkboard SE, Comic Sans MS, cursive", size: "15px" };
const SANS: FontSpec = { family: "Avenir Next, Segoe UI, Helvetica Neue, Helvetica, Arial, Roboto", size: "14px" };

export const STYLE_RECIPES: readonly StyleRecipe[] = [
	{
		id: "blueprint",
		name: "Blueprint",
		description: "Right-angled connectors and a monospace face in a cool engineering blue.",
		hue: 215, mood: "vivid", accentOffset: 140, look: "classic", font: MONO, curve: "step", density: "regular"
	},
	{
		id: "sketchbook",
		name: "Sketchbook",
		description: "Hand-drawn strokes and soft pastel fills, like a whiteboard sketch.",
		hue: 36, mood: "pastel", accentOffset: 170, look: "handDrawn", font: HAND, curve: "basis", density: "compact"
	},
	{
		id: "editorial-ink",
		name: "Editorial Ink",
		description: "Near-monochrome ink on paper with a serif face and generous spacing.",
		hue: 0, mood: "ink", accentOffset: 0, look: "classic", font: SERIF, curve: "linear", density: "roomy"
	},
	{
		id: "sunrise",
		name: "Sunrise",
		description: "Warm coral and apricot pastels with gently curved connectors.",
		hue: 16, mood: "pastel", accentOffset: 160, look: "classic", curve: "basis", density: "regular"
	},
	{
		id: "lagoon",
		name: "Lagoon",
		description: "Saturated teal and sea-green with smooth, flowing connectors.",
		hue: 174, mood: "vivid", accentOffset: 130, look: "classic", curve: "monotoneX", density: "compact"
	},
	{
		id: "grape-soda",
		name: "Grape Soda",
		description: "Playful violet and magenta pastels with rounded cardinal curves.",
		hue: 272, mood: "pastel", accentOffset: 150, look: "classic", curve: "cardinal", density: "regular"
	},
	{
		id: "slate",
		name: "Slate",
		description: "Calm blue-grey tones in a clean sans-serif face, compact and quiet.",
		hue: 228, mood: "muted", accentOffset: 150, look: "classic", font: SANS, curve: "basis", density: "compact"
	},
	{
		id: "terminal",
		name: "Terminal",
		description: "Bright green on a console palette with straight lines and a monospace face.",
		hue: 140, mood: "vivid", accentOffset: 180, look: "classic", font: MONO, curve: "linear", density: "compact"
	}
];

/** Flowchart padding for each density. Other diagram families ignore it. */
export const DENSITY_PADDING: Readonly<Record<Density, number>> = { compact: 12, regular: 14, roomy: 16 };

/** Keeps the recipe's character while letting two notes with the same recipe look different. Range is minus 20 to plus 20 degrees. */
const HUE_JITTER_SPAN = 41;

export function findRecipe(id: string): StyleRecipe | undefined {
	return STYLE_RECIPES.find((recipe) => recipe.id === id);
}

/** Builds a concrete design from a recipe and a seed. The same inputs always return the same design. */
export function designFromRecipe(recipe: StyleRecipe, seed: number): Design {
	const jitter = ((seed >>> 8) % HUE_JITTER_SPAN) - Math.floor(HUE_JITTER_SPAN / 2);
	return {
		recipeId: recipe.id,
		hue: (recipe.hue + jitter + 360) % 360,
		mood: recipe.mood,
		accentOffset: recipe.accentOffset,
		look: recipe.look,
		...(recipe.font ? { font: recipe.font } : {}),
		curve: recipe.curve,
		padding: DENSITY_PADDING[recipe.density],
		seed: (seed % 997) + 1
	};
}

/**
 * Orders the recipes by a seeded shuffle, so consecutive re-rolls of the same note walk through all eight
 * looks without repeating one before the cycle ends.
 */
export function recipeOrder(seed: number): readonly StyleRecipe[] {
	const order = [...STYLE_RECIPES];
	let state = seed >>> 0 || 1;
	for (let i = order.length - 1; i > 0; i -= 1) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const j = state % (i + 1);
		const swap = order[i];
		const other = order[j];
		if (swap && other) {
			order[i] = other;
			order[j] = swap;
		}
	}
	return order;
}

/** Hash of the note identity alone. It fixes the order in which "Another look" walks through the recipes. */
export function noteSeed(title: string, headings: readonly string[]): number {
	return fnv1a([title.trim(), ...headings.map((heading) => heading.trim())].join("\n"));
}

/** Hash of the note identity plus the re-roll counter. It fixes the hue shift and the hand-drawn seed. */
export function lookSeed(title: string, headings: readonly string[], nonce: number): number {
	return fnv1a(`${noteSeed(title, headings)}\n${nonce}`);
}
