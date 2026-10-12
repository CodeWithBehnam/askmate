import { App, Modal } from "obsidian";
import type { ToolApprovalCard, ToolApprovalChoice } from "../requests/runTypes";

const TITLE_ID = "askmate-approval-title";
const BODY_ID = "askmate-approval-body";

/**
 * The approval dialog for one tool call, used when a run brings no card of its own (palette and menu runs). It shows
 * the server, the tool and the full arguments, never a summary the model wrote. Cancel is focused first, closing the
 * dialog counts as a refusal, and a stopped run closes it.
 */
export class ToolApprovalModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly card: ToolApprovalCard,
		private readonly canAllowForChat: boolean,
		private readonly resolve: (choice: ToolApprovalChoice) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass("askmate-approval-modal");
		modalEl.setAttribute("role", "dialog");
		modalEl.setAttribute("aria-modal", "true");
		modalEl.setAttribute("aria-labelledby", TITLE_ID);
		modalEl.setAttribute("aria-describedby", BODY_ID);

		const heading = contentEl.createEl("h2", { text: `Allow ${this.card.title || this.card.tool}?` });
		heading.id = TITLE_ID;
		const body = contentEl.createDiv();
		body.id = BODY_ID;
		body.createEl("p", { text: `The tool ${this.card.tool} on ${this.card.server} was requested by the model. It runs only if you allow it.` });
		if (this.card.changedSinceApproval) {
			body.createEl("p", { cls: ["askmate-status-chip", "is-warning"], text: "Changed since you last approved it" });
		}
		if (this.card.description) {
			body.createEl("p", { text: this.card.description });
		}
		body.createEl("p", { text: "These are the exact arguments it would receive:" });
		body.createEl("pre", { cls: "askmate-tool-args", text: this.card.argumentsJson });

		const row = contentEl.createDiv({ cls: ["askmate-modal-buttons", "askmate-tool-approval-actions"] });
		const deny = row.createEl("button", { text: "Deny" });
		deny.type = "button";
		deny.addEventListener("click", () => {
			this.finish("deny");
		});
		const once = row.createEl("button", { cls: "mod-cta", text: "Allow once" });
		once.type = "button";
		once.addEventListener("click", () => {
			this.finish("allow-once");
		});
		if (this.canAllowForChat) {
			const chat = row.createEl("button", { text: "Allow for this chat" });
			chat.type = "button";
			chat.addEventListener("click", () => {
				this.finish("allow-chat");
			});
		}
		// Refusing is the safe default, so Enter on a freshly opened dialog never allows a call.
		deny.focus();
	}

	onClose(): void {
		this.finish("deny");
	}

	private finish(choice: ToolApprovalChoice): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(choice);
		this.close();
	}
}

/** Opens the dialog and resolves with the choice. A stopped run closes it, which counts as a refusal. */
export function confirmToolCallWithModal(app: App, card: ToolApprovalCard, signal?: AbortSignal): Promise<ToolApprovalChoice> {
	return new Promise<ToolApprovalChoice>((resolve) => {
		const modal = new ToolApprovalModal(app, card, card.canAllowForChat === true, resolve);
		signal?.addEventListener("abort", () => {
			modal.close();
		}, { once: true });
		if (signal?.aborted) {
			resolve("deny");
			return;
		}
		modal.open();
	});
}
