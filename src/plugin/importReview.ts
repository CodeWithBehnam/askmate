/**
 * A workflow preset is text from somewhere else that will run against the person's notes. These helpers decide what to
 * show before it is added: an import never replaces a note by default, and one that could send data somewhere or run code
 * is named first. Pure: the plugin shows the dialog.
 */
import type { CustomWorkflow } from "../shared/types";

/** Links, images and Templater tags in a prompt or template are the ways an imported preset can reach outside the note. */
const REACHES_OUTSIDE = /https?:\/\/|!\[|<%/i;

/** The preset as imported, with the safer output kind when it names none: new content, not a replacement of the note. */
export function withSafeImportDefaults(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	return "outputKind" in value && value.outputKind !== undefined ? value : { ...value, outputKind: "new-content" };
}

export interface ImportConcern {
	name: string;
	reasons: string[];
}

/** Workflows whose prompt or template holds a link, an image embed or a template tag. */
export function findImportConcerns(workflows: ReadonlyArray<Pick<CustomWorkflow, "name" | "prompt" | "resultNoteTemplate">>): ImportConcern[] {
	return workflows.flatMap((workflow) => {
		const reasons = [
			...(REACHES_OUTSIDE.test(workflow.prompt) ? ["its prompt contains a link, an image or a template tag"] : []),
			...(REACHES_OUTSIDE.test(workflow.resultNoteTemplate) ? ["its note template contains a link, an image or a template tag"] : [])
		];
		return reasons.length > 0 ? [{ name: workflow.name, reasons }] : [];
	});
}

export function describeImportConcerns(concerns: readonly ImportConcern[], total: number): string {
	const lines = concerns.map((concern) => `- ${concern.name}: ${concern.reasons.join("; ")}`);
	return [
		`Import ${total} workflow${total === 1 ? "" : "s"}?`,
		"",
		`${concerns.length === 1 ? "This one has" : "These have"} text that can reach outside your note:`,
		...lines,
		"",
		"Read the prompts in the workflow editor after importing, and delete any you do not trust."
	].join("\n");
}
