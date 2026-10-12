/** A skill described as data. Built-in skills and starter templates are written this way and rendered to SKILL.md text. */
export interface SkillDefinition {
	name: string;
	title: string;
	description: string;
	whenToUse?: string;
	triggers: readonly string[];
	version: string;
	icon?: string;
	accent?: string;
	outputKind?: string;
	/** Set for skills that must only run when chosen. */
	disableModelInvocation?: boolean;
	license?: string;
	compatibility?: string;
	body: string;
}

/** A JSON string is a valid double-quoted YAML scalar, so quoting through it can never produce broken frontmatter. */
const yamlString = (value: string): string => JSON.stringify(value);

/** Renders a definition as an Agent Skills compatible SKILL.md file. */
export function renderSkillMarkdown(definition: SkillDefinition): string {
	const lines = [
		"---",
		`name: ${definition.name}`,
		`title: ${yamlString(definition.title)}`,
		`description: ${yamlString(definition.description)}`
	];
	if (definition.whenToUse) {
		lines.push(`when_to_use: ${yamlString(definition.whenToUse)}`);
	}
	if (definition.triggers.length > 0) {
		lines.push("triggers:", ...definition.triggers.map((trigger) => `  - ${yamlString(trigger)}`));
	}
	if (definition.disableModelInvocation) {
		lines.push("disable-model-invocation: true");
	}
	if (definition.outputKind) {
		lines.push(`output-kind: ${definition.outputKind}`);
	}
	if (definition.icon) {
		lines.push(`icon: ${definition.icon}`);
	}
	if (definition.accent) {
		lines.push(`accent: ${yamlString(definition.accent)}`);
	}
	if (definition.license) {
		lines.push(`license: ${yamlString(definition.license)}`);
	}
	if (definition.compatibility) {
		lines.push(`compatibility: ${yamlString(definition.compatibility)}`);
	}
	lines.push("metadata:", "  author: askmate", `  version: ${yamlString(definition.version)}`, "---", "", definition.body.trim(), "");
	return lines.join("\n");
}
