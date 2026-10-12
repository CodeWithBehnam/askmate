import type { Skill, SkillService, SkillStatus } from "../../../skills";
import type { SkillSelection, SkillUsed } from "./pluginApi";

/**
 * Pure rules for choosing skills from the sidebar: validating what the person typed, building the selection a run
 * carries, and wording the lists. Nothing here reaches the vault or the plugin.
 */

export type SkillLookup =
	| { ok: true; skill: Skill }
	| { ok: false; message: string; settings: boolean };

type SkillFinder = Pick<SkillService, "find" | "get" | "statusOf">;

/** Whether a skill can be used right now, and if not, a sentence that says what to do. */
export function lookUpSkill(service: SkillFinder, ref: string): SkillLookup {
	const name = ref.trim();
	const skill = service.find(name) ?? service.get(name);
	if (!skill) {
		return { ok: false, message: `There is no skill called "${name}". Type /skills to see what is available.`, settings: false };
	}
	if (!skill.valid) {
		return { ok: false, message: `The skill "${skill.name}" has errors and cannot be used. Open settings to fix it.`, settings: true };
	}
	if (!skill.manifest.userInvocable) {
		return { ok: false, message: `The skill "${skill.name}" can only be chosen by AskMate, not directly.`, settings: false };
	}
	const status: SkillStatus = service.statusOf(skill);
	if (status === "needs-review") {
		return { ok: false, message: `The skill "${skill.name}" needs your review before AskMate can use it. Open settings to review it.`, settings: true };
	}
	if (status === "disabled") {
		return { ok: false, message: `The skill "${skill.name}" is turned off. Turn it on in settings to use it.`, settings: true };
	}
	if (status === "invalid") {
		return { ok: false, message: `The skill "${skill.name}" has errors and cannot be used. Open settings to fix it.`, settings: true };
	}
	return { ok: true, skill };
}

export interface SelectionInput {
	/** Skills named for this question only: chips, @skill:name, /skill name question, a diagram request. */
	explicit: readonly string[];
	/** Skills kept on for the conversation. */
	sticky: readonly string[];
	/** False for "Run again without skill". */
	autoEnabled: boolean;
}

function unique(values: readonly string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

/** What a run carries. A skill that is both sticky and explicit is listed once, as explicit. */
export function buildSkillSelection(input: SelectionInput): SkillSelection {
	const explicitIds = unique(input.explicit);
	return {
		explicitIds,
		stickyIds: unique(input.sticky).filter((id) => !explicitIds.includes(id)),
		autoEnabled: input.autoEnabled
	};
}

export function describeSkillChannel(channel: string): string {
	switch (channel) {
		case "explicit":
			return "you chose it";
		case "sticky":
			return "kept on for this conversation";
		case "workflow":
			return "the workflow uses it";
		case "auto":
			return "AskMate picked it for this question";
		default:
			return channel;
	}
}

/** Badge text for a reply; one line per skill so the cause is never hidden. */
export function describeSkillBadge(used: SkillUsed): { text: string; title: string } {
	return {
		text: `Skill: ${used.name}`,
		title: `${used.name} (${used.source === "built-in" ? "built in" : "your vault"}): ${describeSkillChannel(used.channel)}.`
	};
}

/** True when running the question again without skills would change anything. */
export function wasSkillAutomatic(used: readonly SkillUsed[] | undefined): boolean {
	return (used ?? []).some((skill) => skill.channel === "auto");
}

export function skillStatusLabel(status: SkillStatus): string {
	switch (status) {
		case "built-in":
			return "built in";
		case "ready":
			return "ready";
		case "needs-review":
			return "needs review";
		case "invalid":
			return "has errors";
		case "disabled":
			return "turned off";
	}
}

/** Text for /skills: every skill with its status, what it costs and what it is for, and what is on for this conversation. */
export function formatSkillsListing(
	skills: readonly Skill[],
	statusOf: (skill: Skill) => SkillStatus,
	stickyIds: readonly string[]
): string {
	const visible = skills.filter((skill) => skill.valid || skill.source === "vault");
	if (visible.length === 0) {
		return "No skills are available. Open settings, then Skills and tools, to add one.";
	}
	const width = Math.max(...visible.map((skill) => skill.name.length)) + 2;
	const lines = visible.map((skill) => {
		const marker = stickyIds.includes(skill.id) ? "*" : " ";
		const status = skillStatusLabel(statusOf(skill));
		const description = skill.manifest.description.replace(/\s+/g, " ").trim();
		return `  ${marker} ${skill.name.padEnd(width)}${status.padEnd(14)}${description.length > 70 ? `${description.slice(0, 67)}...` : description}`;
	});
	return [
		"Skills (* is on for this conversation)",
		...lines,
		"",
		"Use one for a question with /skill <name> <question> or @skill:name.",
		"Keep one on for the conversation with /skill <name>."
	].join("\n");
}
