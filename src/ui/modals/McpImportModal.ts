import { Modal, type App } from "obsidian";
import { parseMcpImport, type ImportResult } from "../../mcp";
import { addModalButton, applyDialogSemantics, createButtonRow } from "./dialog";

export interface ImportPreviewServer {
	label: string;
	kind: string;
	/** The command or address, as it will be saved. Display only. */
	target: string;
	secretCount: number;
	warnings: readonly string[];
}

export interface ImportPreview {
	servers: readonly ImportPreviewServer[];
	skipped: ReadonlyArray<{ name: string; reason: string }>;
	error: string | null;
	/** What the confirm button says, or null while there is nothing to import. */
	confirmLabel: string | null;
}

/** What the person is shown before anything is saved: each server, where it points, how many secrets move, and what was left out. */
export function buildImportPreview(result: ImportResult): ImportPreview {
	const servers = result.servers.map((server): ImportPreviewServer => {
		const config = server.config;
		return {
			label: config.label,
			kind: config.transport === "stdio" ? "Local program" : "Remote server",
			target: config.transport === "stdio" ? [config.command, ...config.args].join(" ") : config.url,
			secretCount: server.secrets.length,
			warnings: server.warnings
		};
	});
	const count = servers.length;
	return {
		servers,
		skipped: result.skipped,
		error: result.error,
		confirmLabel: count === 0 ? null : `Import ${count.toLocaleString("en-GB")} ${count === 1 ? "server" : "servers"}`
	};
}

/**
 * Pastes JSON from another MCP client and shows what it would add. Nothing is saved here: the dialog resolves with the parsed
 * result, and the caller stores secrets and definitions. Imported servers are never trusted; each still needs the trust dialog.
 */
export class McpImportModal extends Modal {
	private resolved = false;
	private result: ImportResult | null = null;

	constructor(app: App, private readonly takenIds: ReadonlySet<string>, private readonly resolve: (result: ImportResult | null) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("askmate-modal-wide");
		this.modalEl.addClass("askmate-trust-modal");
		this.setTitle("Import tool servers");
		const intro = contentEl.createEl("p", {
			cls: "askmate-modal-message",
			text: "Paste the JSON from another MCP app. AskMate shows what it found before it saves anything, and imported servers stay off until you trust each one."
		});
		applyDialogSemantics(this, intro);
		const label = contentEl.createEl("label", { cls: "askmate-prompt-inspector-label", text: "Server JSON" });
		const textarea = contentEl.createEl("textarea", { cls: "askmate-prompt-inspector-textarea" });
		textarea.id = "askmate-mcp-import-json";
		label.htmlFor = textarea.id;
		textarea.rows = 10;
		textarea.placeholder = "{\n  \"mcpServers\": {\n    \"example\": { \"command\": \"npx\", \"args\": [\"-y\", \"example-server\"] }\n  }\n}";
		const previewEl = contentEl.createDiv({ cls: "askmate-mcp-import-preview", attr: { role: "status" } });
		const actions = createButtonRow(contentEl);
		addModalButton(actions, "Cancel", { onClick: () => this.finish(null) });
		addModalButton(actions, "Review", {
			onClick: () => {
				this.result = parseMcpImport(textarea.value, this.takenIds);
				const preview = buildImportPreview(this.result);
				this.renderPreview(previewEl, preview);
				importButton.disabled = preview.confirmLabel === null;
				importButton.setText(preview.confirmLabel ?? "Import");
			}
		});
		const importButton = addModalButton(actions, "Import", {
			cta: true,
			onClick: () => {
				if (this.result && this.result.servers.length > 0) {
					this.finish(this.result);
				}
			}
		});
		importButton.disabled = true;
		textarea.focus();
	}

	private renderPreview(parent: HTMLElement, preview: ImportPreview): void {
		parent.empty();
		if (preview.error) {
			parent.createDiv({ cls: "askmate-settings-callout is-warning", text: preview.error });
		}
		for (const server of preview.servers) {
			const block = parent.createDiv({ cls: "askmate-trust-fact" });
			block.createEl("p", { cls: "askmate-modal-message", text: `${server.label} · ${server.kind}` });
			block.createEl("pre", { cls: "askmate-tool-args" }).createEl("code", { text: server.target });
			if (server.secretCount > 0) {
				block.createEl("p", { cls: "askmate-settings-note", text: `${server.secretCount.toLocaleString("en-GB")} ${server.secretCount === 1 ? "secret" : "secrets"} will be saved in your system keychain, not in your vault.` });
			}
			for (const warning of server.warnings) {
				block.createDiv({ cls: "askmate-settings-callout is-warning", text: warning });
			}
		}
		for (const skipped of preview.skipped) {
			parent.createEl("p", { cls: "askmate-settings-note", text: `Skipped ${skipped.name}: ${skipped.reason}` });
		}
	}

	onClose(): void {
		this.finish(null);
	}

	private finish(result: ImportResult | null): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.resolve(result);
		this.close();
	}
}

/** Opens the import dialog. Resolves with the parsed servers when the person confirmed, or null. */
export function askMcpImport(app: App, takenIds: ReadonlySet<string>): Promise<ImportResult | null> {
	return new Promise((resolve) => {
		new McpImportModal(app, takenIds, resolve).open();
	});
}
