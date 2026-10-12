import { Modal, type App } from "obsidian";
import { addModalButton, applyDialogSemantics, createButtonRow } from "./dialog";

export type NewServerTransport = "stdio" | "http";

export interface NewServerInput {
	label: string;
	/** The command for a local program, or the address of a remote server. */
	target: string;
}

/** The words of the dialog for each kind of server. */
export const NEW_SERVER_COPY: Readonly<Record<NewServerTransport, { title: string; intro: string; targetLabel: string; targetPlaceholder: string; labelPlaceholder: string }>> = {
	stdio: {
		title: "Add a local program",
		intro: "A local program runs on this computer with your permissions. Give it a name and the program to run. You add its arguments and set it up on the next page, and nothing starts until you trust it.",
		targetLabel: "Program to run",
		targetPlaceholder: "Program to run",
		labelPlaceholder: "Name"
	},
	http: {
		title: "Add a remote server",
		intro: "A remote server receives the arguments of each tool call. Give it a name and its address. You set it up on the next page, and nothing is contacted until you trust it.",
		targetLabel: "Server address",
		targetPlaceholder: "Server address",
		labelPlaceholder: "Name"
	}
};

/**
 * Asks for the two things a server cannot exist without. A server is only created once these are valid, because the settings
 * loader would drop an entry with no command or address the next time it saves. `validate` returns a plain reason, or null.
 */
export class McpAddServerModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly transport: NewServerTransport,
		private readonly validate: (input: NewServerInput) => string | null,
		private readonly resolve: (input: NewServerInput | null) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const copy = NEW_SERVER_COPY[this.transport];
		contentEl.empty();
		this.setTitle(copy.title);
		const intro = contentEl.createEl("p", { cls: "askmate-modal-message", text: copy.intro });
		applyDialogSemantics(this, intro);

		const labelInput = contentEl.createEl("input", { type: "text", attr: { "aria-label": "Name", placeholder: copy.labelPlaceholder } });
		labelInput.addClass("askmate-modal-input");
		const targetInput = contentEl.createEl("input", { type: "text", attr: { "aria-label": copy.targetLabel, placeholder: copy.targetPlaceholder } });
		targetInput.addClass("askmate-modal-input");
		// The alert region exists from the start and is empty and unstyled, so a message added later is announced.
		const error = contentEl.createDiv({ attr: { role: "alert" } });

		const submit = (): void => {
			const input = { label: labelInput.value.trim(), target: targetInput.value.trim() };
			const problem = this.validate(input);
			if (problem) {
				error.setText(problem);
				error.addClass("askmate-settings-callout", "is-warning");
				return;
			}
			this.finish(input);
		};
		for (const input of [labelInput, targetInput]) {
			input.addEventListener("keydown", (event) => {
				// Enter while an IME candidate is open commits the candidate, not the form.
				if (event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					submit();
				}
			});
		}

		const actions = createButtonRow(contentEl);
		addModalButton(actions, "Cancel", { onClick: () => this.finish(null) });
		addModalButton(actions, "Add server", { cta: true, onClick: submit });
		labelInput.focus();
	}

	onClose(): void {
		this.finish(null);
	}

	private finish(input: NewServerInput | null): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(input);
		this.close();
	}
}

/** Opens the dialog. Resolves with the name and target once they are valid, or null when the person gives up. */
export function askNewServer(app: App, transport: NewServerTransport, validate: (input: NewServerInput) => string | null): Promise<NewServerInput | null> {
	return new Promise((resolve) => {
		new McpAddServerModal(app, transport, validate, resolve).open();
	});
}
