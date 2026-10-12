// The per-request design brief. It goes into the model input (not the instructions) because it changes with every note and every "Another look".

import { KIND_KEYWORDS } from "./header";
import { designFromRecipe, lookSeed, noteSeed, recipeOrder } from "./recipes";
import { ROLES } from "./palette";
import { DIAGRAM_KINDS, type Design, type Kind, type Role, type StyleRecipe } from "./types";

export interface DiagramBrief {
	readonly recipe: StyleRecipe;
	readonly design: Design;
	/** The hash behind the hue shift and the hand-drawn seed. Changes with every nonce. */
	readonly seed: number;
	/** The block to place in the model input. */
	readonly text: string;
}

export interface DiagramBriefInput {
	readonly title: string;
	readonly headings: readonly string[];
	/** Starts at 0 and goes up by one for every "Another look". */
	readonly nonce: number;
	/** Families the host Mermaid can parse, from supportedDiagrams. Omit to leave the choice open. */
	readonly supported?: readonly Kind[];
	/** A family the user picked. Omit or pass undefined for Auto. */
	readonly kind?: Kind;
}

const ROLE_MEANING: Readonly<Record<Role, string>> = {
	primary: "the main subject or step",
	accent: "a decision, hand-off or key idea",
	success: "a good outcome",
	warn: "a risk or caution",
	danger: "a failure or blocker",
	muted: "optional or background detail",
	ink: "a start, an end or an outside actor"
};

/** How a role tag is written in each family that supports classDef. Verified to parse on Mermaid 11.13.0. */
const TAGGING =
	"Tags work in flowchart (A[Label]:::primary), stateDiagram-v2 (class Idle primary), classDiagram (class Thread:::primary), erDiagram (THREAD:::primary), block-beta (class a primary) and treemap-beta (\"Notes\": 40:::primary). Do not tag other diagram types.";

/** The keyword plus anything the first line needs. A flowchart has no direction unless the model writes one. */
const FIRST_LINE: Readonly<Record<Kind, string>> = { ...KIND_KEYWORDS, flowchart: "flowchart TD (or LR)" };

/** Re-rolls are cyclic: eight consecutive nonces visit all eight recipes before any repeats. */
function pickRecipe(order: readonly StyleRecipe[], nonce: number): StyleRecipe {
	const whole = Number.isFinite(nonce) ? Math.trunc(nonce) : 0;
	const index = ((whole % order.length) + order.length) % order.length;
	return order[index];
}

function typeLine(kind: Kind | undefined, supported: readonly Kind[] | undefined): string {
	if (kind !== undefined) {
		return `Diagram type: draw a ${kind} diagram. First line: ${FIRST_LINE[kind]}`;
	}
	const choices = (supported ?? DIAGRAM_KINDS).map((name) => FIRST_LINE[name]);
	return `Diagram type: pick the one that fits the content best. First line is one of: ${choices.join(", ")}`;
}

export function buildDiagramBrief(input: DiagramBriefInput): DiagramBrief {
	const recipe = pickRecipe(recipeOrder(noteSeed(input.title, input.headings)), input.nonce);
	const seed = lookSeed(input.title, input.headings, input.nonce);
	const design = designFromRecipe(recipe, seed);
	const text = [
		"<diagram_brief>",
		`Look: ${recipe.name}. ${recipe.description} AskMate builds the header and the colours; write only the diagram body.`,
		typeLine(input.kind, input.supported),
		"Size: about 12 nodes or fewer. If the content needs more, draw the most important part and say what was left out.",
		"Colour roles: tag nodes with a role instead of choosing colours. Never write frontmatter, %% directives or classDef lines.",
		...ROLES.map((role) => `- ${role}: ${ROLE_MEANING[role]}`),
		TAGGING,
		"</diagram_brief>"
	].join("\n");
	return { recipe, design, seed, text };
}
