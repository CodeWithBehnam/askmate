import { MarkdownView, Notice } from "obsidian";
import { ASKMATE_VIEW_TYPE } from "../settings/constants";
import { isInsertable, type LastAnswer } from "../ui/sidebar/answerActions";
import { copyAnswerText, insertAnswerIntoEditor } from "../ui/sidebar/answerShell";
import { AskMateView } from "../ui/sidebar/AskMateView";
import type { AskMatePlugin } from "./AskMatePlugin";

/**
 * The newest answer in an open sidebar. A sidebar restored at start-up is a deferred leaf whose view is only a
 * placeholder, so each leaf is loaded before it is asked, or the commands would say there is no answer.
 */
async function findLastAnswer(plugin: AskMatePlugin): Promise<LastAnswer | null> {
	for (const leaf of plugin.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)) {
		await leaf.loadIfDeferred();
		if (leaf.view instanceof AskMateView) {
			const answer = leaf.view.getLastAnswer();
			if (answer) {
				return answer;
			}
		}
	}
	return null;
}

/** Command palette entries for the newest answer in an open AskMate sidebar. */
export function registerAnswerCommands(plugin: AskMatePlugin): void {
	plugin.addCommand({
		id: "copy-last-answer",
		name: "Copy last answer",
		callback: async () => {
			const answer = await findLastAnswer(plugin);
			if (!isInsertable(answer)) {
				new Notice("There is no AskMate answer to copy yet.");
				return;
			}
			await copyAnswerText(answer.text);
		}
	});

	plugin.addCommand({
		id: "insert-last-answer",
		name: "Insert last answer at cursor",
		editorCallback: async (editor, ctx) => {
			// The palette restores the editor, so the command's own editor is the right target even when the view is hidden.
			if (ctx instanceof MarkdownView && ctx.getMode() !== "source") {
				new Notice("Switch the note to editing mode (not reading view) to insert the answer.");
				return;
			}
			insertAnswerIntoEditor(editor, await findLastAnswer(plugin));
		}
	});
}
