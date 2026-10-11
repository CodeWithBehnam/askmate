import { Notice, type Editor, type MarkdownView } from "obsidian";
import { formatInsertNotice, isInsertable, prepareInsertText, type LastAnswer } from "./answerActions";

/** Clipboard and editor side effects for answer actions. Callers pass the raw reply, never rendered DOM. */
export async function copyAnswerText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice("Copied");
	} catch {
		new Notice("AskMate could not copy to the clipboard. Select the text and copy it manually.");
	}
}

export function insertAnswerIntoEditor(editor: Editor, answer: LastAnswer | null): void {
	if (!isInsertable(answer)) {
		new Notice("There is no AskMate answer to insert yet.");
		return;
	}
	// Replaces the selection when there is one, otherwise inserts at the cursor.
	editor.replaceSelection(prepareInsertText(answer.text));
	new Notice(formatInsertNotice(answer));
}

/**
 * The sidebar steals focus from the note, so the active Markdown view is usually null there; the remembered view
 * is the fallback. Never writes without an editor.
 */
export function insertAnswerAtRememberedCursor(
	activeView: MarkdownView | null,
	rememberedView: MarkdownView | null,
	answer: LastAnswer | null
): void {
	const view = activeView ?? rememberedView;
	if (!view) {
		new Notice("Click into the note where the answer should go, then try again.");
		return;
	}
	if (view.getMode() !== "source") {
		new Notice("Switch the note to editing mode (not reading view) to insert the answer.");
		return;
	}
	insertAnswerIntoEditor(view.editor, answer);
}
