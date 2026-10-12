import { Modal, type App } from "obsidian";
import { addModalButton, applyDialogSemantics, createButtonRow } from "./dialog";
import { markInvisibleCharacters } from "./invisibleChars";

export type ToolApprovalChoice = "allow-once" | "allow-chat" | "deny";

/**
 * What the dialog needs. It is structurally the card McpHost.confirmCall receives, with everything but the identity of the
 * call optional, so a lighter card from the sidebar can use it too.
 */
export interface ToolApprovalModalInput {
	serverLabel: string;
	toolName: string;
	toolTitle?: string;
	/** Pretty-printed JSON of exactly what will be sent. Never truncated. */
	argumentsText: string;
	warnings?: readonly string[];
	/** The server's own description. Untrusted text, shown as is. */
	description?: string;
	reason?: "first-use" | "changed" | "mode" | "possible-side-effect";
	/** The tool definition differs from the one approved before. */
	changedSinceApproval?: boolean;
	/** False when there is no conversation to scope a grant to. */
	canAllowForChat?: boolean;
	/** The server's readOnlyHint, shown as an unverified claim. */
	claimsReadOnly?: boolean;
}

export const TOOL_APPROVAL_REASON_COPY: Readonly<Record<NonNullable<ToolApprovalModalInput["reason"]>, string>> = {
	"first-use": "This tool has not been approved on this device before.",
	changed: "This tool changed since you last approved it. Read the arguments and description again.",
	mode: "This server is set to ask before every tool call.",
	"possible-side-effect": "This server is trusted for read-only tools, but this tool does not say it is read-only."
};

/**
 * The per-call approval dialog. Deny keeps the focus, and Escape, the close button and any other way of leaving the dialog count
 * as Deny, because the tool runs only on an explicit Allow.
 */
export class ToolApprovalModal extends Modal {
	private resolved = false;

	constructor(app: App, private readonly input: ToolApprovalModalInput, private readonly resolve: (choice: ToolApprovalChoice) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, input } = this;
		contentEl.empty();
		this.modalEl.addClass("askmate-approval-modal");
		this.modalEl.addClass("askmate-modal-wide");
		this.setTitle("Allow this tool call?");
		const summary = contentEl.createEl("p", {
			cls: "askmate-modal-message",
			text: `${input.serverLabel} wants to run "${input.toolTitle?.trim() || input.toolName}". It runs only if you allow it.`
		});
		applyDialogSemantics(this, summary);

		if (input.changedSinceApproval === true) {
			contentEl.createDiv({ cls: "askmate-settings-callout is-warning", text: TOOL_APPROVAL_REASON_COPY.changed, attr: { role: "alert" } });
		} else if (input.reason) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: TOOL_APPROVAL_REASON_COPY[input.reason] });
		}
		if (input.claimsReadOnly === true) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: "The server says this tool only reads data. AskMate cannot check that claim." });
		}
		for (const warning of input.warnings ?? []) {
			contentEl.createDiv({ cls: "askmate-settings-callout is-warning", text: warning });
		}
		if (input.description?.trim()) {
			contentEl.createEl("p", { cls: "askmate-settings-note", text: `What the server says it does: ${input.description.trim()}` });
		}

		const argsMarked = markInvisibleCharacters(input.argumentsText);
		const argsLabel = contentEl.createEl("p", { cls: "askmate-modal-message", text: "Arguments sent to the tool", attr: { id: "askmate-tool-args-label" } });
		// The arguments can be long and scroll, so the region takes keyboard focus and is named by the label above it.
		const args = contentEl.createEl("pre", { cls: "askmate-tool-args", attr: { tabindex: "0", role: "region", "aria-labelledby": argsLabel.id } });
		args.createEl("code", { text: argsMarked.text });
		if (argsMarked.flagged) {
			contentEl.createDiv({ cls: "askmate-settings-callout is-warning", text: "The arguments hold characters you cannot normally see. They are shown in square brackets." });
		}

		const actions = createButtonRow(contentEl);
		actions.addClass("askmate-tool-approval-actions");
		const deny = addModalButton(actions, "Deny", { onClick: () => this.finish("deny") });
		addModalButton(actions, "Allow once", { cta: true, onClick: () => this.finish("allow-once") });
		if (input.canAllowForChat !== false) {
			addModalButton(actions, "Allow for this chat", { onClick: () => this.finish("allow-chat") });
		}
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

/**
 * Opens the dialog and resolves with the choice. An aborted run closes the dialog and answers Deny, so a stopped answer never
 * leaves a prompt waiting.
 */
export function askToolApproval(app: App, input: ToolApprovalModalInput, signal?: AbortSignal): Promise<ToolApprovalChoice> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve("deny");
			return;
		}
		const modal = new ToolApprovalModal(app, input, (choice) => {
			signal?.removeEventListener("abort", onAbort);
			resolve(choice);
		});
		const onAbort = (): void => modal.close();
		signal?.addEventListener("abort", onAbort, { once: true });
		modal.open();
	});
}
