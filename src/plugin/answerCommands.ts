import { MarkdownView, Notice } from "obsidian";
import { ASKMATE_VIEW_TYPE } from "../settings/constants";
import { isInsertable, type LastAnswer } from "../ui/sidebar/answerActions";
import { copyAnswerText, insertAnswerIntoEditor } from "../ui/sidebar/answerShell";
import { AskMateView } from "../ui/sidebar/AskMateView";
import type { AskMatePlugin } from "./AskMatePlugin";

function findLastAnswer(plugin: AskMatePlugin): LastAnswer | null {
	for (const leaf of plugin.app.workspace.getLeavesOfType(ASKMATE_VIEW_TYPE)) {
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
		name: "Copy last AskMate answer",
		callback: () => {
			const answer = findLastAnswer(plugin);
			if (!isInsertable(answer)) {
				new Notice("There is no AskMate answer to copy yet.");
				return;
			}
			void copyAnswerText(answer.text);
		}
	});

	plugin.addCommand({
		id: "insert-last-answer",
		name: "Insert last AskMate answer at cursor",
		editorCallback: (editor, ctx) => {
			// The palette restores the editor, so the command's own editor is the right target even when the view is hidden.
			if (ctx instanceof MarkdownView && ctx.getMode() !== "source") {
				new Notice("Switch the note to editing mode (not reading view) to insert the answer.");
				return;
			}
			insertAnswerIntoEditor(editor, findLastAnswer(plugin));
		}
	});
}
