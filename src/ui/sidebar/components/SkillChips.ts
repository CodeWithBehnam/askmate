import type { Skill, SkillSuggestion } from "../../../skills";

/**
 * The skill row above the composer: skills kept on for the conversation, skills chosen for the next question, and at
 * most one suggestion. The model is pure; the renderer only draws it and reports clicks.
 */

export type SkillChipState = "sticky" | "once" | "suggested";

export interface SkillChipModel {
	id: string;
	state: SkillChipState;
	label: string;
	title: string;
	/** Screen reader name, which says what a click does. */
	ariaLabel: string;
}

export type SkillLite = Pick<Skill, "id" | "name" | "characters"> & { manifest: Pick<Skill["manifest"], "title"> };

export interface SkillChipsInput {
	sticky: readonly SkillLite[];
	once: readonly SkillLite[];
	suggestion: Pick<SkillSuggestion, "id" | "name" | "reason"> | null;
	/** Display title for a suggestion, which carries only the name. */
	suggestionTitle?: string;
}

function displayName(skill: SkillLite): string {
	return skill.manifest.title.trim() || skill.name;
}

function cost(characters: number): string {
	return `${characters.toLocaleString("en-GB")} characters`;
}

export function buildSkillChips(input: SkillChipsInput): SkillChipModel[] {
	const chips: SkillChipModel[] = [];
	const seen = new Set<string>();
	for (const skill of input.sticky) {
		seen.add(skill.id);
		chips.push({
			id: skill.id,
			state: "sticky",
			label: displayName(skill),
			title: `${displayName(skill)} is on for this conversation. It adds ${cost(skill.characters)} to each request. Click to turn it off.`,
			ariaLabel: `${displayName(skill)}, on for this conversation. Turn off.`
		});
	}
	for (const skill of input.once) {
		if (seen.has(skill.id)) {
			continue;
		}
		seen.add(skill.id);
		chips.push({
			id: skill.id,
			state: "once",
			label: displayName(skill),
			title: `${displayName(skill)} is used for your next question only. It adds ${cost(skill.characters)}. Click to remove it.`,
			ariaLabel: `${displayName(skill)}, used for the next question. Remove.`
		});
	}
	const suggestion = input.suggestion;
	if (suggestion && !seen.has(suggestion.id)) {
		const name = input.suggestionTitle?.trim() || suggestion.name;
		chips.push({
			id: suggestion.id,
			state: "suggested",
			label: `${name}?`,
			title: `${suggestion.reason || `This question looks like a job for ${name}.`} Click to use it for the next question.`,
			ariaLabel: `Suggested skill: ${name}. Use it for the next question.`
		});
	}
	return chips;
}

export function skillChipsSignature(chips: readonly SkillChipModel[]): string {
	return chips.map((chip) => `${chip.state}:${chip.id}:${chip.label}`).join("|");
}

export interface SkillChipCallbacks {
	/** A sticky or one-off chip was clicked: turn it off. */
	onRemove: (chip: SkillChipModel) => void;
	/** The suggestion was clicked: use it for the next question. */
	onAccept: (chip: SkillChipModel) => void;
}

export function renderSkillChips(container: HTMLElement, chips: readonly SkillChipModel[], callbacks: SkillChipCallbacks): void {
	container.empty();
	container.hidden = chips.length === 0;
	container.setAttribute("role", "group");
	container.setAttribute("aria-label", "Skills");
	for (const chip of chips) {
		const classes = ["askmate-skill-chip", chip.state === "suggested" ? "is-suggested" : "is-active"];
		const button = container.createEl("button", { cls: classes.join(" "), text: chip.label });
		button.type = "button";
		button.setAttribute("title", chip.title);
		button.setAttribute("aria-label", chip.ariaLabel);
		if (chip.state !== "suggested") {
			button.setAttribute("aria-pressed", "true");
		}
		button.addEventListener("click", () => {
			if (chip.state === "suggested") {
				callbacks.onAccept(chip);
			} else {
				callbacks.onRemove(chip);
			}
		});
	}
}
