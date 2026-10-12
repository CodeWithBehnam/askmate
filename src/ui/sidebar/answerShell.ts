import { Notice, type App, type Editor, type MarkdownView } from "obsidian";
import { askInsertRiskChoice, type InsertRiskChoice } from "./components/InsertRiskModal";
import { describeInserted, planAnswerInsert, type InsertableReply } from "./components/insertPlan";

/** Clipboard and editor side effects for answer actions. Callers pass the raw reply, never rendered DOM. */
export async function copyAnswerText(text: string): Promise<void> {
	try {
		// The active window's clipboard: the sidebar can live in a popout window, where the main window's is not allowed.
		await activeWindow.navigator.clipboard.writeText(text);
		new Notice("Copied");
	} catch {
		new Notice("AskMate could not copy to the clipboard. Select the text and copy it manually.");
	}
}

/** Asks what to do with a reply that holds active content. The sidebar passes a dialog; the command palette passes none. */
export type InsertRiskChooser = (findings: readonly string[]) => Promise<InsertRiskChoice>;

function insertAt(editor: Editor, text: string): void {
	// A selection is collapsed to its end first, so inserting never replaces the text the person had selected.
	if (editor.somethingSelected()) {
		editor.setCursor(editor.getCursor("to"));
	}
	editor.replaceSelection(text);
}

/**
 * Inserts the newest reply at the cursor. Without a chooser (the command palette), a reply with active content goes in as its safe version.
 * Never replaces a selection.
 */
export function insertAnswerIntoEditor(editor: Editor, answer: InsertableReply | null, options: { targetLabel?: string } = {}): void {
	const plan = planAnswerInsert(answer);
	if (plan.kind === "none" || !answer) {
		new Notice("There is no AskMate answer to insert yet.");
		return;
	}
	const label = options.targetLabel ?? "";
	if (plan.kind === "risky") {
		insertAt(editor, plan.safe);
		new Notice(describeInserted(label, answer, { safeVersion: true }));
		return;
	}
	insertAt(editor, plan.text);
	new Notice(describeInserted(label, answer));
}

/** The sidebar's Insert: checks the reply, asks when it holds active content, then inserts. */
export async function insertAnswerWithChoice(
	editor: Editor,
	answer: InsertableReply | null,
	chooseRisk: InsertRiskChooser,
	options: { targetLabel?: string } = {}
): Promise<void> {
	const plan = planAnswerInsert(answer);
	if (plan.kind === "none" || !answer) {
		new Notice("There is no AskMate answer to insert yet.");
		return;
	}
	const label = options.targetLabel ?? "";
	if (plan.kind === "plain") {
		insertAt(editor, plan.text);
		new Notice(describeInserted(label, answer));
		return;
	}
	const choice = await chooseRisk(plan.findings);
	if (choice === "cancel") {
		new Notice("Nothing was inserted.");
		return;
	}
	insertAt(editor, choice === "safe" ? plan.safe : plan.original);
	new Notice(describeInserted(label, answer, { safeVersion: choice === "safe" }));
}

/**
 * The sidebar steals focus from the note, so the active Markdown view is usually null there; the remembered view
 * is the fallback. Never writes without an editor.
 */
export async function insertAnswerAtRememberedCursor(
	app: App,
	activeView: MarkdownView | null,
	rememberedView: MarkdownView | null,
	answer: InsertableReply | null
): Promise<void> {
	const view = activeView ?? rememberedView;
	if (!view) {
		new Notice("Click into the note where the answer should go, then try again.");
		return;
	}
	if (view.getMode() !== "source") {
		new Notice("Switch the note to editing mode (not reading view) to insert the answer.");
		return;
	}
	await insertAnswerWithChoice(view.editor, answer, (findings) => askInsertRiskChoice(app, findings), {
		targetLabel: view.file?.path ?? ""
	});
}
