import { Modal, type App } from "obsidian";
import type { TrustRequest } from "../../mcp";
import { addModalButton, applyDialogSemantics, createButtonRow } from "./dialog";
import { markInvisibleCharacters } from "./invisibleChars";

/** One line of the exact details the person is asked to trust. */
export interface TrustFact {
	label: string;
	value: string;
	/** True for text that must be read exactly, such as a command line, so it is shown in a monospace block. */
	code?: boolean;
}

export interface TrustModalModel {
	title: string;
	intro: string;
	/** Shown first and prominently when the definition changed since it was trusted. */
	changedNotice: string | null;
	/** Advisory warnings from the MCP layer, such as a secret that was not stored for this server. */
	risks: readonly string[];
	facts: readonly TrustFact[];
	confirmLabel: string;
	cancelLabel: string;
}

function envFact(entry: Extract<TrustRequest, { transport: "stdio" }>["env"][number]): string {
	return entry.secret ? `${entry.name} = stored secret "${entry.secretId ?? "unknown"}"` : `${entry.name} = ${entry.value}`;
}

/**
 * The words and details of the trust dialog, with nothing drawn yet. Plain values are shown in full and secrets are shown by the
 * id they are read from, so the person can see which stored secret goes to which program or host.
 */
export function buildTrustModalModel(request: TrustRequest): TrustModalModel {
	const changedNotice = request.reason === "changed"
		? "The settings for this server changed since you last trusted it. Check every detail below again."
		: null;
	if (request.transport === "stdio") {
		return {
			title: request.reason === "changed" ? "Trust the changed local server?" : "Trust this local server?",
			intro: `"${request.label}" is a program that runs on your computer. If you trust it, AskMate starts it with your user permissions when an answer needs its tools. It can read files and use the network like any program you run yourself.`,
			changedNotice,
			risks: request.risks,
			facts: [
				{ label: "Command", value: request.commandLine, code: true },
				...(request.env.length > 0 ? [{ label: "Environment variables", value: request.env.map(envFact).join("\n"), code: true }] : [{ label: "Environment variables", value: "None added by AskMate." }])
			],
			confirmLabel: "Trust and start",
			cancelLabel: "Cancel"
		};
	}
	const secretHeaders = request.secretHeaders.map((header) => `${header.name} = stored secret "${header.secretId}"`);
	const plainHeaders = request.headerNames.filter((name) => !request.secretHeaders.some((header) => header.name === name));
	return {
		title: request.reason === "changed" ? "Trust the changed remote server?" : "Trust this remote server?",
		intro: `"${request.label}" is a server on the network. If you trust it, AskMate sends requests to ${request.host}, including the tool arguments the model chooses, whenever an answer needs its tools.`,
		changedNotice,
		risks: request.risks,
		facts: [
			{ label: "Address", value: request.url, code: true },
			{ label: "Receives your requests at", value: request.host },
			{
				label: "Bearer token",
				value: request.bearerSecretId === null ? "None." : `Stored secret "${request.bearerSecretId}" is sent to ${request.host}.`
			},
			{ label: "Headers with stored secrets", value: secretHeaders.length > 0 ? secretHeaders.join("\n") : "None.", code: secretHeaders.length > 0 },
			{ label: "Other headers", value: plainHeaders.length > 0 ? plainHeaders.join(", ") : "None." }
		],
		confirmLabel: "Trust and connect",
		cancelLabel: "Cancel"
	};
}

/**
 * Asks the person to trust one server definition on this device. Cancel keeps the focus, and Escape, the close button and any
 * other way of leaving the dialog answer no, because trust is only ever an explicit yes.
 */
export class McpTrustModal extends Modal {
	private resolved = false;

	constructor(app: App, private readonly request: TrustRequest, private readonly resolve: (trusted: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const model = buildTrustModalModel(this.request);
		contentEl.empty();
		this.modalEl.addClass("askmate-trust-modal");
		this.modalEl.addClass("askmate-modal-wide");
		this.setTitle(model.title);
		const intro = contentEl.createEl("p", { cls: "askmate-modal-message", text: model.intro });
		applyDialogSemantics(this, intro);

		if (model.changedNotice) {
			contentEl.createDiv({ cls: "askmate-settings-callout is-warning", text: model.changedNotice, attr: { role: "alert" } });
		}
		for (const risk of model.risks) {
			contentEl.createDiv({ cls: "askmate-settings-callout is-warning", text: risk, attr: { role: "alert" } });
		}
		for (const fact of model.facts) {
			const block = contentEl.createDiv({ cls: "askmate-trust-fact" });
			const label = block.createEl("p", { cls: "askmate-modal-message", text: fact.label });
			if (fact.code) {
				const marked = markInvisibleCharacters(fact.value);
				// A command is read exactly, so hidden characters inside it are made visible instead of being trusted blind.
				block.createEl("pre", { cls: "askmate-tool-args", attr: { tabindex: "0", role: "region", "aria-label": fact.label } }).createEl("code", { text: marked.text });
				if (marked.flagged) {
					block.createDiv({ cls: "askmate-settings-callout is-warning", text: "This text holds characters you cannot normally see. They are shown in square brackets." });
				}
			} else {
				block.createEl("p", { cls: "askmate-settings-note", text: fact.value });
			}
			label.addClass("askmate-trust-fact-label");
		}

		const actions = createButtonRow(contentEl);
		addModalButton(actions, model.cancelLabel, { onClick: () => this.finish(false) }).focus();
		addModalButton(actions, model.confirmLabel, { cta: true, onClick: () => this.finish(true) });
	}

	onClose(): void {
		this.finish(false);
	}

	private finish(trusted: boolean): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(trusted);
		this.close();
	}
}

/** Opens the trust dialog and resolves true only when the person chose to trust. */
export function askMcpTrust(app: App, request: TrustRequest): Promise<boolean> {
	return new Promise((resolve) => {
		new McpTrustModal(app, request, resolve).open();
	});
}
