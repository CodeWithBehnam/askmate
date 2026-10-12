import type { SavedToolCall } from "../../../threads/threadModel";
import type { ToolApprovalCard, ToolApprovalChoice, ToolUiEvent } from "../../../requests/runTypes";
import { approvalCardName, describeSavedToolCall, formatToolArguments, isFinalToolStatus, previewToolResult, showHiddenCharacters, toolCardName, toolStatusText } from "./toolModel";

/**
 * One card per tool call, inside the answer it belongs to. While a call waits for approval the card shows the full
 * arguments and the three choices; afterwards it keeps the outcome. Tool text comes from outside AskMate, so every
 * string here is set as text and none is rendered as Markdown.
 */

export interface ToolCardHandle {
	el: HTMLElement;
	update(event: ToolUiEvent): void;
	/** Shows the approval buttons and resolves with the choice. Resolves "deny" if the card is cancelled. */
	requestApproval(request: ToolApprovalCard, options: { canAllowForChat: boolean }): Promise<ToolApprovalChoice>;
	/** Turns a waiting approval into a denial, for example when the run is stopped. */
	cancelApproval(): void;
}

export function createToolCallCard(parent: HTMLElement, initial: ToolUiEvent): ToolCardHandle {
	const card = parent.createDiv({ cls: "askmate-tool-card" });
	card.setAttribute("role", "group");
	const header = card.createDiv({ cls: "askmate-tool-card-header" });
	const name = header.createSpan({ cls: "askmate-tool-card-name" });
	const status = header.createSpan({ cls: "askmate-tool-card-status" });
	const description = card.createDiv({ cls: "askmate-tool-card-desc" });
	description.hidden = true;
	const warning = card.createDiv({ cls: "askmate-tool-warning" });
	warning.hidden = true;
	const argsDetails = card.createEl("details", { cls: "askmate-tool-card-args" });
	argsDetails.createEl("summary", { text: "Arguments" });
	const args = argsDetails.createEl("pre", { cls: "askmate-tool-args" });
	const actions = card.createDiv({ cls: "askmate-tool-approval-actions" });
	actions.hidden = true;
	const result = card.createDiv({ cls: "askmate-tool-result" });
	result.hidden = true;

	let pending: ((choice: ToolApprovalChoice) => void) | null = null;
	let current = initial;
	const stateClasses = ["is-pending", "is-running", "is-done", "is-error", "is-denied"];

	const render = (event: ToolUiEvent): void => {
		current = event;
		card.removeClasses(stateClasses);
		card.addClass(`is-${event.status === "pending-approval" ? "pending" : event.status}`);
		const label = toolCardName(event);
		name.setText(label);
		status.setText(toolStatusText(event.status));
		card.setAttribute("aria-label", `Tool call ${label}: ${toolStatusText(event.status)}`);
		if (event.argumentsJson || !args.textContent) {
			args.setText(formatToolArguments(event.argumentsJson));
		}
		const text = event.error ? event.error : event.resultPreview ? previewToolResult(event.resultPreview) : "";
		result.hidden = text === "";
		result.setText(text);
		result.classList.toggle("is-error", Boolean(event.error));
		if (isFinalToolStatus(event.status) && pending) {
			settle("deny");
		}
	};

	const settle = (choice: ToolApprovalChoice): void => {
		const done = pending;
		pending = null;
		actions.empty();
		actions.hidden = true;
		done?.(choice);
	};

	render(initial);

	return {
		el: card,
		update: render,
		requestApproval(request, options) {
			if (pending) {
				settle("deny");
			}
			render({ ...current, status: "pending-approval", argumentsJson: request.argumentsJson });
			// The real tool name stays in the header next to any title the server gave it.
			name.setText(approvalCardName(request));
			if (request.description) {
				description.hidden = false;
				description.setText(showHiddenCharacters(request.description));
			}
			if (request.changedSinceApproval) {
				warning.hidden = false;
				warning.setText("This tool changed since you last approved it. Read the arguments carefully.");
			}
			// What will be sent is open for reading while the question is open.
			argsDetails.open = true;
			actions.hidden = false;
			actions.empty();
			const choices: Array<{ choice: ToolApprovalChoice; label: string; cta?: boolean }> = [
				{ choice: "allow-once", label: "Allow once", cta: true },
				...(options.canAllowForChat ? [{ choice: "allow-chat" as const, label: "Allow for this chat" }] : []),
				{ choice: "deny", label: "Deny" }
			];
			for (const item of choices) {
				const button = actions.createEl("button", { text: item.label, cls: item.cta ? "mod-cta" : "" });
				button.type = "button";
				button.addEventListener("click", () => settle(item.choice));
			}
			return new Promise<ToolApprovalChoice>((resolve) => {
				pending = resolve;
			});
		},
		cancelApproval() {
			if (pending) {
				settle("deny");
			}
		}
	};
}

/** A compact read-only list of the calls a saved reply made. Arguments are not kept, so none are shown. */
export function renderSavedToolCalls(parent: HTMLElement, calls: readonly SavedToolCall[]): HTMLElement | null {
	if (calls.length === 0) {
		return null;
	}
	const list = parent.createDiv({ cls: "askmate-tool-cards" });
	list.setAttribute("role", "list");
	for (const call of calls) {
		const item = list.createDiv({ cls: `askmate-tool-card is-${call.status === "completed" ? "done" : call.status === "denied" ? "denied" : "error"}`, text: describeSavedToolCall(call) });
		item.setAttribute("role", "listitem");
	}
	return list;
}
