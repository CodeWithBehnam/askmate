export const EDITOR_MENU_MAX_WORKFLOWS = 6;

/** Used when the user has starred no workflow, so the menu is still useful on a fresh install. */
export const EDITOR_MENU_DEFAULT_WORKFLOW_IDS: readonly string[] = ["rewrite-polish", "explain-simply", "study-summary", "translate-preserve"];

export interface EditorMenuWorkflow {
	id: string;
	name: string;
}

export type EditorMenuEntry =
	| { kind: "ask-selection"; title: string }
	| { kind: "ask-note"; title: string }
	| { kind: "workflow"; title: string; workflowId: string };

export interface EditorMenuInput {
	enabled: boolean;
	hasSelection: boolean;
	/** Visible workflows only (hidden ones already removed), in sidebar order. */
	visibleWorkflows: readonly EditorMenuWorkflow[];
	favouriteIds: ReadonlySet<string>;
	maxWorkflows?: number;
}

export function buildEditorMenuEntries(input: EditorMenuInput): EditorMenuEntry[] {
	if (!input.enabled) {
		return [];
	}
	if (!input.hasSelection) {
		return [{ kind: "ask-note", title: "AskMate: Ask about this note" }];
	}
	const favourites = input.visibleWorkflows.filter((workflow) => input.favouriteIds.has(workflow.id));
	const chosen = favourites.length > 0
		? favourites
		: EDITOR_MENU_DEFAULT_WORKFLOW_IDS.flatMap((id) => input.visibleWorkflows.filter((workflow) => workflow.id === id));
	return [
		{ kind: "ask-selection", title: "AskMate: Ask about selection" },
		...chosen.slice(0, Math.max(0, input.maxWorkflows ?? EDITOR_MENU_MAX_WORKFLOWS)).map((workflow): EditorMenuEntry => ({
			kind: "workflow",
			title: `AskMate: ${workflow.name}`,
			workflowId: workflow.id
		}))
	];
}
