import { Menu, Notice, Platform, SettingGroup, type App, type SettingDefinition, type SettingDefinitionItem, type ToggleComponent } from "obsidian";
import {
	MAX_SERVERS,
	MCP_SECRET_PREFIX,
	isValidHeaderName,
	secretIdFor,
	slugifyServerId,
	validateServerConfig,
	type ImportResult,
	type McpService,
	type McpServerState,
	type McpServerStatus
} from "../../mcp";
import {
	MAX_MCP_ARGS,
	MCP_OUTPUT_CHARS_BOUNDS,
	MCP_TOOL_ROUNDS_BOUNDS,
	normalizeMcpSettings,
	normalizeMcpSettingsWithDiagnostics,
	type McpApprovalMode,
	type McpEnvValue,
	type McpServerConfig,
	type McpSettings
} from "../../shared/core";
import { askMateConfirm } from "../modals/modals";
import { askNewServer } from "../modals/McpAddServerModal";
import { askMcpImport } from "../modals/McpImportModal";
import { linkFragment, statusChipClass, type ChipTone, type SettingsPageHost } from "./connectionPage";
import { uniqueLabels } from "./settingsInputs";
import { pluralise } from "./settingsSummaries";

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

export const MCP_DOCS_URL = "https://github.com/CodeWithBehnam/askmate/blob/main/docs/mcp.md";

/** How long a notice stays that names something the person has to act on. */
const LONG_NOTICE_MS = 15000;

export const APPROVAL_LABELS: Readonly<Record<McpApprovalMode, string>> = {
	"always-ask": "Ask before every call",
	"ask-once-per-chat": "Ask once for each tool in a chat",
	"trusted-read-only": "Ask unless the tool only reads"
};

export const APPROVAL_HELP: Readonly<Record<McpApprovalMode, string>> = {
	"always-ask": "Every call shows its arguments and waits for you, and nothing is remembered: the card offers only Allow once and Deny. This is the safest choice.",
	"ask-once-per-chat": "The first call of each tool in a chat waits for you. The card then offers Allow for this chat, and once you choose it that tool runs without asking again in that conversation.",
	"trusted-read-only": "Tools that the server says only read data run without asking, once you turn on Believe the server's read-only labels. AskMate cannot check that claim, so use it only for servers you trust. Every other tool asks, and its card offers Allow for this chat."
};

/** The only hosts a remote server may reach over plain HTTP. Every other address needs HTTPS. */
export const PLAIN_HTTP_HOSTS_TEXT = "localhost, 127.0.0.1 and [::1]";

export const ADDRESS_HELP = `The HTTPS address of the server. Plain HTTP is accepted only for ${PLAIN_HTTP_HOSTS_TEXT}; a server elsewhere on your network needs HTTPS.`;

export const PLAIN_HTTP_KEPT_OFF_NOTICE = `AskMate kept this server off: plain HTTP is only allowed for ${PLAIN_HTTP_HOSTS_TEXT}, so use an HTTPS address.`;

export function transportLabel(transport: McpServerConfig["transport"]): string {
	return transport === "stdio" ? "Local program" : "Remote server";
}

export interface ServerChip {
	tone: ChipTone;
	label: string;
	detail: string | null;
}

/** What a server's chip says. Every state has words, because colour alone is not announced. */
export function describeServerState(state: McpServerState): ServerChip {
	switch (state.kind) {
		case "off":
			return { tone: "off", label: "Off", detail: null };
		case "needs-trust":
			return { tone: "warning", label: "Needs trust", detail: "Trust this server on this device before it can start." };
		case "idle":
			return { tone: "off", label: "Not started", detail: "It starts the first time an answer needs its tools." };
		case "connecting":
			return { tone: "busy", label: "Connecting", detail: null };
		case "ready":
			return { tone: "ready", label: `Ready, ${pluralise(state.tools, "tool")}`, detail: state.hidden > 0 ? `${pluralise(state.hidden, "tool")} hidden or turned off.` : null };
		case "needs-auth":
			return { tone: "warning", label: "Needs a token", detail: state.hint };
		case "error":
			return { tone: "error", label: "Error", detail: state.fix ? `${state.message} ${state.fix}` : state.message };
	}
}

/**
 * The state to show when there is no running service to ask, for example while AskMate is still starting. Trust lives on this
 * device and only the service can read it, so an enabled, valid server is shown as needing trust rather than as ready.
 */
export function staticServerState(mcp: Pick<McpSettings, "enabled">, server: McpServerConfig): McpServerState {
	if (!mcp.enabled || !server.enabled) {
		return { kind: "off" };
	}
	const problems = validateServerConfig(server);
	return problems.length > 0
		? { kind: "error", error: "unsupported", message: problems[0] ?? "The settings are not valid.", fix: null }
		: { kind: "needs-trust" };
}

export function summarizeServerStatuses(mcp: Pick<McpSettings, "enabled" | "servers">, statuses: readonly McpServerStatus[]): { total: number; ready: number; attention: number } {
	const states = mcp.servers.map((server) => statuses.find((status) => status.id === server.id)?.state ?? staticServerState(mcp, server));
	return {
		total: mcp.servers.length,
		ready: states.filter((state) => state.kind === "ready").length,
		attention: states.filter((state) => state.kind === "needs-trust" || state.kind === "needs-auth" || state.kind === "error").length
	};
}

const DEFAULT_LABELS: Readonly<Record<McpServerConfig["transport"], string>> = { stdio: "Local program", http: "Remote server" };

/**
 * A new, switched-off definition. Nothing about it is trusted, and the cautious approval mode is already chosen. A server needs
 * its command or address from the start, because the settings loader drops an entry without one the next time it saves.
 */
export function newServer(transport: McpServerConfig["transport"], input: { label: string; target: string }, takenIds: ReadonlySet<string>): McpServerConfig {
	const label = input.label.replace(/\s+/g, " ").trim().slice(0, 60) || DEFAULT_LABELS[transport];
	const base = { id: slugifyServerId(label, takenIds), label, enabled: false, approval: "always-ask" as const, trustsAnnotations: false, trustedConfigHash: null };
	const target = input.target.trim();
	return transport === "stdio"
		? { ...base, transport: "stdio", command: target, args: [], env: {} }
		: { ...base, transport: "http", url: target, headers: {}, bearerSecretId: null };
}

/** The reason the settings loader gave when it dropped a server or a value, without the "AskMate dropped" lead-in. */
function plainReason(message: string | undefined): string | null {
	const reason = message?.replace(/^.*?":\s*/, "").trim();
	return reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}` : null;
}

/**
 * Why this definition cannot be saved, or null when it can. The settings loader decides what survives a save, so it is asked
 * rather than copied: a definition it would drop or alter must never reach the page as if it had been kept.
 */
export function checkServerCandidate(server: McpServerConfig): string | null {
	const { settings, diagnostics } = normalizeMcpSettingsWithDiagnostics({ enabled: true, servers: [server] });
	if (settings.servers.length === 0) {
		return plainReason(diagnostics.find((diagnostic) => diagnostic.code === "mcp-server-dropped")?.message) ?? "The server settings are not valid.";
	}
	return plainReason(diagnostics.find((diagnostic) => diagnostic.code === "mcp-value-dropped")?.message);
}

export function parseArgsText(text: string): string[] {
	return text.split(/\r?\n/).map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "");
}

export function formatArgsText(args: readonly string[]): string {
	return args.join("\n");
}

// The settings loader drops a plain value under a name like these, or shaped like a known credential, so each must be a secret here.
// The patterns match the loader's own. This list is a courtesy: checkServerCandidate asks the loader before anything is saved.
const SENSITIVE_NAME = /token|secret|passw|api[-_]?key|auth|credential|signature|bearer|cookie|session|private[-_]?key|(?:^|[-_.])(?:key|sig|pwd)$/i;
const CREDENTIAL_VALUE = /^(?:Bearer\s|Basic\s|gh[pousr]_|github_pat_|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.)/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// The loader keeps header names of letters, digits and hyphens only, which is narrower than what the protocol allows.
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
const MAX_VALUE_LENGTH = 4096;

export function isSensitiveName(name: string): boolean {
	return SENSITIVE_NAME.test(name);
}

export type VariablePlan =
	| { ok: true; name: string; value: McpEnvValue; secret: { id: string; value: string } | null; forcedSecret: boolean }
	| { ok: false; message: string };

/**
 * Turns the "add a variable or header" form into a stored entry. Anything that looks like a credential is stored as a secret in
 * the keychain whether or not the person ticked the box, because a credential in data.json would sync with the vault.
 */
export function planVariable(input: { kind: "env" | "header"; serverId: string; name: string; value: string; asSecret: boolean; existingSecretId?: string }): VariablePlan {
	const name = input.name.trim();
	const noun = input.kind === "env" ? "variable" : "header";
	if (!name) {
		return { ok: false, message: `Enter a ${noun} name.` };
	}
	if (input.kind === "env" ? !ENV_NAME.test(name) : !(HEADER_NAME.test(name) && isValidHeaderName(name))) {
		return { ok: false, message: input.kind === "env"
			? `"${name}" is not a valid variable name. Use letters, digits and underscores, and do not start with a digit.`
			: `"${name}" is not a header name that AskMate allows. Use letters, digits and hyphens; AskMate sets some headers itself.` };
	}
	if (!input.value) {
		return { ok: false, message: `Enter a value for ${name}.` };
	}
	if (input.value.length > MAX_VALUE_LENGTH || input.value.includes("\0") || (input.kind === "header" && /[\r\n]/.test(input.value))) {
		return { ok: false, message: `The value for ${name} is too long or has a character that is not allowed.` };
	}
	const forcedSecret = !input.asSecret && (isSensitiveName(name) || CREDENTIAL_VALUE.test(input.value.trim()));
	if (input.asSecret || forcedSecret) {
		const id = chooseServerSecretId(input.serverId, name, input.existingSecretId);
		return { ok: true, name, value: { kind: "secret", secretId: id }, secret: { id, value: input.value }, forcedSecret };
	}
	return { ok: true, name, value: { kind: "plain", value: input.value }, secret: null, forcedSecret: false };
}

/**
 * The keychain id a server's secret is saved under. An id AskMate made for this server is reused, so replacing a value leaves no
 * orphan. Any other id may belong to another plugin or to the AI provider key, so it is never overwritten.
 */
export function chooseServerSecretId(serverId: string, name: string, current: string | undefined): string {
	return current !== undefined && current.startsWith(`${MCP_SECRET_PREFIX}${serverId}-`) ? current : secretIdFor(serverId, name);
}

/** The ids of every secret a server points at that AskMate created for it. These are wiped when the server is deleted. */
export function ownedSecretIds(server: McpServerConfig): string[] {
	const values = server.transport === "stdio" ? Object.values(server.env) : Object.values(server.headers);
	const ids = [
		...values.flatMap((value) => value.kind === "secret" ? [value.secretId] : []),
		...(server.transport === "http" && server.bearerSecretId ? [server.bearerSecretId] : [])
	];
	return ids.filter((id) => id.startsWith(`${MCP_SECRET_PREFIX}${server.id}-`));
}

/**
 * What to tell the person after a token was saved. Trust covers the name of the secret, never its value, so pasting a new token
 * under the name AskMate already uses leaves the server trusted, and only a different name asks for trust again.
 */
export function describeTokenSaved(previousSecretId: string | null, savedSecretId: string): string {
	return previousSecretId === savedSecretId
		? "Token replaced on this device. The server stays trusted because the token's name did not change."
		: "Token saved on this device. The server asks for trust again because its settings changed.";
}

export const TRUST_REVOKED_TEXT = "Trust revoked. The server is stopped and asks again before it starts.";

/** The question before a delete. Trust on this device is cleared with the server, whether or not tools are on. */
export function describeServerDeletion(label: string): string {
	return `Delete the server "${label}"? AskMate also wipes the secrets it stored for this server and forgets the trust you gave it on this device. The program or service itself is not touched.`;
}

/** What to tell the person when secrets could not be wiped, or null when all were. The ids are keychain names, never values. */
export function describeUnwipedSecrets(label: string, ids: readonly string[]): string | null {
	if (ids.length === 0) {
		return null;
	}
	return `Deleted "${label}", but AskMate could not wipe ${pluralise(ids.length, "stored secret")}: ${ids.join(", ")}. Remove ${ids.length === 1 ? "it" : "them"} from the keychain in Obsidian's settings.`;
}

/** Wipes each secret and returns the ids that refused, so a failure is reported instead of lost. */
export function wipeSecrets(wipe: (id: string) => void, ids: readonly string[]): string[] {
	const failed: string[] = [];
	for (const id of ids) {
		try {
			wipe(id);
		} catch {
			failed.push(id);
		}
	}
	return failed;
}

export function setToolAllowed(disabledTools: readonly string[] | undefined, tool: string, allowed: boolean): string[] {
	const rest = (disabledTools ?? []).filter((name) => name !== tool);
	return allowed ? rest : [...rest, tool];
}

function toSettingsServer(config: ImportResult["servers"][number]["config"]): McpServerConfig {
	const base = {
		id: config.id,
		label: config.label,
		// Imported servers arrive off. Turning one on happens in the trust dialog, after the person has read the exact command.
		enabled: false,
		approval: config.approval,
		trustsAnnotations: false,
		trustedConfigHash: null
	};
	return config.transport === "stdio"
		? { ...base, transport: "stdio", command: config.command, args: [...config.args], env: { ...config.env } }
		: { ...base, transport: "http", url: config.url, headers: { ...config.headers }, bearerSecretId: config.bearerSecretId };
}

/**
 * Adds imported servers to the settings. They are switched off and carry no trust. The result goes through the settings
 * normaliser, which drops anything it would not accept on load, so what is saved now is what is loaded later.
 */
export function applyMcpImport(mcp: McpSettings, result: ImportResult): { mcp: McpSettings; secrets: ImportResult["servers"][number]["secrets"]; added: number } {
	const room = Math.max(0, MAX_SERVERS - mcp.servers.length);
	const accepted = result.servers.slice(0, room);
	const next = normalizeMcpSettings({ ...mcp, servers: [...mcp.servers, ...accepted.map((server) => toSettingsServer(server.config))] }, true);
	return { mcp: next, secrets: accepted.flatMap((server) => server.secrets), added: next.servers.length - mcp.servers.length };
}

export type TrustAndTestResult =
	| { kind: "tools-off"; message: string }
	| { kind: "invalid"; message: string }
	| { kind: "declined"; message: string }
	| { kind: "tested"; message: string; status: McpServerStatus | null; ready: boolean }
	| { kind: "failed"; message: string };

export function describeTestStatus(status: McpServerStatus | null): { ready: boolean; message: string } {
	if (!status) {
		return { ready: false, message: "That server no longer exists." };
	}
	const chip = describeServerState(status.state);
	return { ready: status.state.kind === "ready", message: chip.detail ? `${chip.label}. ${chip.detail}` : `${chip.label}.` };
}

/**
 * Trust, then start and test one server. The trust dialog comes first and nothing runs until it is accepted. A server that was off
 * is switched on only after the person has trusted it, because trusting it is what they came to do.
 */
export async function runTrustAndTest(deps: {
	service: Pick<McpService, "trust" | "testConnection">;
	mcp: Pick<McpSettings, "enabled">;
	server: McpServerConfig;
	enable: () => Promise<void>;
	signal?: AbortSignal;
	errorMessage: (error: unknown) => string;
}): Promise<TrustAndTestResult> {
	const { service, mcp, server } = deps;
	if (!mcp.enabled) {
		return { kind: "tools-off", message: "Turn on tools first, then try again." };
	}
	const problems = validateServerConfig(server);
	if (problems.length > 0) {
		return { kind: "invalid", message: problems[0] ?? "The server settings are not valid." };
	}
	try {
		const outcome = await service.trust(server.id);
		if (outcome.kind === "declined") {
			return { kind: "declined", message: "Not trusted, so the server was not started." };
		}
		if (outcome.kind === "invalid") {
			return { kind: "invalid", message: outcome.message };
		}
		if (!server.enabled) {
			await deps.enable();
		}
		const status = await service.testConnection(server.id, deps.signal);
		const described = describeTestStatus(status);
		return { kind: "tested", message: described.message, status, ready: described.ready };
	} catch (error) {
		return { kind: "failed", message: deps.errorMessage(error) };
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings writes
// ---------------------------------------------------------------------------------------------------------------------

async function saveMcp(host: SettingsPageHost, next: McpSettings): Promise<void> {
	host.plugin.settings.mcp = next;
	await host.saveUiSetting();
	// Stops anything that was edited, removed or switched off; the next run asks for trust again if the definition changed.
	await host.plugin.mcpService?.reconcile();
}

/**
 * Applies a change to one server and saves it, or says why it cannot be saved and changes nothing. The settings loader would drop
 * or alter a definition it does not accept, so the change is checked first and a refused one never reaches the page as if it stuck.
 */
async function updateServer(host: SettingsPageHost, serverId: string, change: (server: McpServerConfig) => McpServerConfig): Promise<string | null> {
	const mcp = host.plugin.settings.mcp;
	const current = mcp.servers.find((server) => server.id === serverId);
	if (!current) {
		return "That server no longer exists.";
	}
	const next = change(current);
	const problem = checkServerCandidate(next);
	if (problem) {
		return problem;
	}
	await saveMcp(host, { ...mcp, servers: mcp.servers.map((server) => server.id === serverId ? next : server) });
	return null;
}

/** For changes that cannot be wrong on their own, such as a switch: a refusal becomes an error that the caller reports. */
async function changeServer(host: SettingsPageHost, serverId: string, change: (server: McpServerConfig) => McpServerConfig): Promise<void> {
	const problem = await updateServer(host, serverId, change);
	if (problem) {
		throw new Error(problem);
	}
}

function currentServer(host: SettingsPageHost, serverId: string): McpServerConfig | undefined {
	return host.plugin.settings.mcp.servers.find((server) => server.id === serverId);
}

function bearerIdOf(server: McpServerConfig | undefined): string | null {
	return server?.transport === "http" ? server.bearerSecretId : null;
}

function writeSecret(app: App, id: string, value: string): void {
	// The keychain has no delete, so an empty value is how a secret is wiped.
	app.secretStorage.setSecret(id, value);
}

function stateOf(host: SettingsPageHost, server: McpServerConfig): McpServerState {
	const status = host.plugin.mcpService?.status().find((candidate) => candidate.id === server.id);
	return status?.state ?? staticServerState(host.plugin.settings.mcp, server);
}

// ---------------------------------------------------------------------------------------------------------------------
// The tools part of the Skills and tools page
// ---------------------------------------------------------------------------------------------------------------------

export function buildToolsItems(host: SettingsPageHost): SettingDefinitionItem[] {
	const { app, plugin } = host;
	const settings = plugin.settings;
	const toolsOn = (): boolean => settings.mcp.enabled;
	const servers = settings.mcp.servers;
	const labels = uniqueLabels(servers.map((server) => server.label));

	const aboutRow: SettingDefinition = {
		name: "About tools",
		desc: linkFragment([
			"Tools let the model use programs and services that you connect, through the Model Context Protocol. They are off until you turn them on, and AskMate asks before every call. ",
			{ text: "Read how tools work", href: MCP_DOCS_URL },
			"."
		]),
		searchable: false
	};

	const enableRow: SettingDefinition = {
		name: "Allow tools",
		desc: "Let answers use the servers below. Nothing starts until you trust a server.",
		aliases: ["mcp", "model context protocol", "tool calls"],
		render: (setting) => {
			setting.addToggle((toggle) => {
				let reverting = false;
				host.setupToggle(toggle, "Allow tools", settings.mcp.enabled, async (value) => {
					if (reverting) {
						return;
					}
					if (value && !(await askMateConfirm(app, "Tools let the model ask AskMate to run programs on your computer or contact services you add below. A server only starts after you trust it, and every call asks you first unless you choose otherwise.", {
						title: "Turn on tools?",
						confirmLabel: "Turn on tools"
					}))) {
						reverting = true;
						toggle.setValue(false);
						toggle.toggleEl.setAttribute("aria-checked", "false");
						reverting = false;
						return;
					}
					await host.runSettingAction(() => saveMcp(host, { ...settings.mcp, enabled: value }));
					host.refreshDomState();
				});
			});
		}
	};

	const limitRows: SettingDefinition[] = [
		host.integerDefinition("Tool rounds per answer", `The model may call tools in this many turns (${MCP_TOOL_ROUNDS_BOUNDS.min} to ${MCP_TOOL_ROUNDS_BOUNDS.max}). It then gets one more turn, without tools, to write the answer.`, {
			bounds: { min: MCP_TOOL_ROUNDS_BOUNDS.min, max: MCP_TOOL_ROUNDS_BOUNDS.max },
			getValue: () => settings.mcp.maxToolRoundsPerTurn,
			setValue: (value) => {
				settings.mcp = { ...settings.mcp, maxToolRoundsPerTurn: value };
			}
		}, { visible: toolsOn }),
		host.integerDefinition("Longest tool result", `A tool result is cut at exactly this many characters before the model sees it (${MCP_OUTPUT_CHARS_BOUNDS.min.toLocaleString("en-GB")} to ${MCP_OUTPUT_CHARS_BOUNDS.max.toLocaleString("en-GB")}), and a short note tells the model it was cut.`, {
			bounds: { min: MCP_OUTPUT_CHARS_BOUNDS.min, max: MCP_OUTPUT_CHARS_BOUNDS.max },
			getValue: () => settings.mcp.maxOutputChars,
			setValue: (value) => {
				settings.mcp = { ...settings.mcp, maxOutputChars: value };
			}
		}, { visible: toolsOn })
	];

	const addServer = async (transport: McpServerConfig["transport"]): Promise<void> => {
		const taken = new Set(settings.mcp.servers.map((server) => server.id));
		if (settings.mcp.servers.length >= MAX_SERVERS) {
			new Notice(`AskMate keeps up to ${MAX_SERVERS} servers. Delete one first.`);
			return;
		}
		// The dialog only lets a server through once the loader would keep it, so nothing half-made is ever saved.
		const input = await askNewServer(app, transport, (candidate) => checkServerCandidate(newServer(transport, candidate, taken)));
		if (!input) {
			return;
		}
		const server = newServer(transport, input, taken);
		await saveMcp(host, { ...settings.mcp, servers: [...settings.mcp.servers, server] });
		new Notice(`Added "${server.label}". Open it to add its arguments and trust it.`);
		host.update();
	};

	const importServers = async (): Promise<void> => {
		const result = await askMcpImport(app, new Set(settings.mcp.servers.map((server) => server.id)));
		if (!result) {
			return;
		}
		const applied = applyMcpImport(settings.mcp, result);
		const failures: string[] = [];
		for (const secret of applied.secrets) {
			try {
				writeSecret(app, secret.secretId, secret.value);
			} catch (error) {
				failures.push(`${secret.source}: ${plugin.getErrorMessage(error)}`);
			}
		}
		await saveMcp(host, applied.mcp);
		new Notice(failures.length > 0
			? `Imported ${pluralise(applied.added, "server")}, but ${pluralise(failures.length, "secret")} could not be saved. Set ${failures.length === 1 ? "it" : "them"} again in the server settings.`
			: `Imported ${pluralise(applied.added, "server")}. They are off until you trust each one.`);
		host.update();
	};

	const showAddMenu = (anchor: HTMLElement): void => {
		const menu = new Menu();
		if (Platform.isDesktopApp) {
			menu.addItem((item) => item.setTitle("Local program").setIcon("terminal").onClick(() => {
				void host.runSettingAction(() => addServer("stdio"));
			}));
		}
		menu.addItem((item) => item.setTitle("Remote server").setIcon("globe").onClick(() => {
			void host.runSettingAction(() => addServer("http"));
		}));
		menu.addItem((item) => item.setTitle("Import from JSON").setIcon("clipboard-paste").onClick(() => {
			void host.runSettingAction(importServers);
		}));
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	};

	const deleteServerAt = async (index: number): Promise<void> => {
		const server = settings.mcp.servers[index];
		if (!server) {
			return;
		}
		const confirmed = await askMateConfirm(app, describeServerDeletion(server.label), {
			title: "Delete server",
			confirmLabel: "Delete server",
			destructive: true
		});
		if (!confirmed) {
			return;
		}
		await host.runSettingAction(async () => {
			await plugin.revokeMcpTrust(server.id);
			const unwiped = wipeSecrets((id) => writeSecret(app, id, ""), ownedSecretIds(server));
			await saveMcp(host, { ...settings.mcp, servers: settings.mcp.servers.filter((candidate) => candidate.id !== server.id) });
			// The definition that pointed at an unwiped secret is gone, so the notice is the only record of its name.
			const warning = describeUnwipedSecrets(server.label, unwiped);
			if (warning) {
				new Notice(warning, LONG_NOTICE_MS);
			}
			host.update();
		});
	};

	// A real button: the list's own add affordance is a div with an aria-label and no role, which screen readers do not
	// treat as a control (axe aria-prohibited-attr).
	const addServerRow: SettingDefinition = {
		name: "Add a tool server",
		desc: "A local program, a remote server, or servers imported from another app's JSON.",
		aliases: ["add server", "import json", "mcp server"],
		render: (setting) => {
			setting.addButton((button) => {
				button.setButtonText("Add server").onClick(() => showAddMenu(button.buttonEl));
			});
		}
	};

	const serverPages = servers.map((server, index) => {
		const label = labels[index] ?? server.label;
		// Each page keeps the function that ends its status subscription, so leaving or redrawing the page lets go of it.
		const hide: HidePage = { run: () => undefined };
		// What the list shows for this server. Leaving the page redraws the list only when this changed, for example after a rename.
		const listSignature = (live: McpServerConfig | undefined): string => JSON.stringify([live?.label, live?.transport, live?.transport === "http" ? safeHost(live.url) : ""]);
		const shownAs = listSignature(server);
		return host.imperativePage(
			label,
			`${transportLabel(server.transport)}${server.transport === "stdio" ? "" : `, ${safeHost(server.url)}`}`,
			(containerEl, refresh) => renderServerEditor(host, containerEl, server.id, refresh, hide),
			{
				displayValue: () => {
					const live = currentServer(host, server.id);
					return live ? describeServerState(stateOf(host, live)).label : "";
				},
				onHide: () => {
					hide.run();
					if (listSignature(currentServer(host, server.id)) !== shownAs) {
						host.update();
					}
				}
			}
		);
	});

	return [
		{ type: "group", heading: "Tools", items: [aboutRow, enableRow, ...limitRows, addServerRow] },
		{
			type: "list",
			heading: "Tool servers",
			emptyState: "No servers yet. Use Add server above to add one or import JSON from another app.",
			onDelete: (index) => {
				void deleteServerAt(index);
			},
			items: serverPages
		}
	];
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "address not set";
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// One server's page
// ---------------------------------------------------------------------------------------------------------------------

interface HidePage {
	run: () => void;
}

function renderServerEditor(host: SettingsPageHost, containerEl: HTMLElement, serverId: string, refresh: () => void, hide: HidePage): void {
	const { app, plugin } = host;
	const first = currentServer(host, serverId);
	if (!first) {
		containerEl.createEl("p", { cls: "askmate-settings-note", text: "This server no longer exists." });
		return;
	}
	hide.run();

	containerEl.createEl("p", {
		cls: "askmate-settings-note",
		text: first.transport === "stdio"
			? "A local program that AskMate starts on this computer. It runs with your permissions, so only add programs you trust."
			: "A server on the network. AskMate sends it the arguments of each tool call, so only add servers you trust."
	});

	// --- Server ---------------------------------------------------------------------------------------------------------
	const status = { chip: null as HTMLElement | null, detail: null as HTMLElement | null };
	// The switch is the consent control, so it must always show what is stored, including after Trust and test turns the server on.
	const useSwitch = { toggle: null as ToggleComponent | null, syncing: false };
	/** Moves the switch to the stored value without running its handler. */
	const syncUseSwitch = (value: boolean): void => {
		const { toggle } = useSwitch;
		if (!toggle || toggle.getValue() === value) {
			return;
		}
		useSwitch.syncing = true;
		toggle.setValue(value);
		toggle.toggleEl.setAttribute("aria-checked", String(value));
		useSwitch.syncing = false;
	};
	const paintStatus = (): void => {
		const live = currentServer(host, serverId);
		if (!live) {
			return;
		}
		syncUseSwitch(live.enabled);
		if (!status.chip) {
			return;
		}
		const chip = describeServerState(stateOf(host, live));
		status.chip.className = statusChipClass(chip.tone);
		status.chip.setText(chip.label);
		status.detail?.setText(chip.detail ?? "");
	};

	const serverGroup = new SettingGroup(containerEl).setHeading("Server");
	serverGroup.addSetting((setting) => {
		host.prepareFieldFeedback(setting);
		setting.setName("Name").setDesc("Shown in the sidebar and in tool approval prompts.").addText((text) => {
			host.labelControl(text.inputEl, "Server name");
			text.setValue(first.label);
			host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
				const label = text.getValue().replace(/\s+/g, " ").trim().slice(0, 60);
				const kept = currentServer(host, serverId)?.label ?? first.label;
				if (!label) {
					text.setValue(kept);
					host.setFieldFeedback(setting, `A server needs a name. AskMate kept "${kept}".`, "info");
					return;
				}
				text.setValue(label);
				host.setFieldFeedback(setting, await updateServer(host, serverId, (server) => ({ ...server, label })));
			});
		});
	});
	serverGroup.addSetting((setting) => {
		setting.setName("Use this server").setDesc("A server that is off never starts.").addToggle((toggle) => {
			useSwitch.toggle = toggle;
			host.setupToggle(toggle, "Use this server", first.enabled, async (value) => {
				if (useSwitch.syncing) {
					return;
				}
				await host.runSettingAction(() => changeServer(host, serverId, (server) => ({ ...server, enabled: value })));
				// The settings loader keeps a remote server on plain http switched off, so the switch shows what was actually kept.
				if (value && currentServer(host, serverId)?.enabled === false) {
					new Notice(PLAIN_HTTP_KEPT_OFF_NOTICE);
				}
				paintStatus();
			});
		});
	});
	serverGroup.addSetting((setting) => {
		setting.setName("Status").setClass("askmate-mcp-row");
		status.chip = setting.controlEl.createSpan({ cls: statusChipClass("off") });
		status.detail = setting.descEl.createDiv({ cls: "askmate-settings-note" });
		host.prepareFieldFeedback(setting);
		setting.addButton((button) => {
			host.labelControl(button.buttonEl, `Trust and test ${first.label}`);
			button.setButtonText("Trust and test").setCta().onClick(() => {
				void host.keepFocusWhileBusy(button.buttonEl, (busy) => {
					button.setButtonText(busy ? "Testing..." : "Trust and test").setDisabled(busy);
				}, async () => {
					const service = plugin.mcpService;
					const live = currentServer(host, serverId);
					host.setFieldFeedback(setting, null);
					if (!service || !live) {
						host.setFieldFeedback(setting, live ? "Tools are not running yet. Turn on tools, then close and open this page again." : "This server no longer exists.");
						return;
					}
					const result = await runTrustAndTest({
						service,
						mcp: plugin.settings.mcp,
						server: live,
						enable: () => changeServer(host, serverId, (server) => ({ ...server, enabled: true })),
						errorMessage: (error) => plugin.getErrorMessage(error)
					});
					host.setFieldFeedback(setting, result.message, result.kind === "tested" && result.ready ? "success" : result.kind === "declined" ? "info" : "error");
					paintStatus();
					renderTools();
				});
			});
		});
		setting.addButton((button) => {
			host.labelControl(button.buttonEl, `Revoke trust for ${first.label}`);
			button.setButtonText("Revoke trust").onClick(() => {
				void host.runSettingAction(async () => {
					// A failure throws, and runSettingAction shows it, so the line below is only reached once the trust was forgotten.
					await plugin.revokeMcpTrust(serverId);
					host.setFieldFeedback(setting, TRUST_REVOKED_TEXT, "info");
					paintStatus();
					renderTools();
				});
			});
		});
		paintStatus();
	});

	// --- Connection -----------------------------------------------------------------------------------------------------
	const connection = new SettingGroup(containerEl).setHeading("Connection");
	if (first.transport === "stdio") {
		connection.addSetting((setting) => {
			host.prepareFieldFeedback(setting);
			setting.setName("Command").setDesc("The program to run, for example npx or uvx. Put each argument in the box below, not here.").addText((text) => {
				host.labelControl(text.inputEl, "Command");
				text.setPlaceholder("Program to run").setValue(first.command);
				host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
					const command = text.getValue().trim();
					const live = currentServer(host, serverId);
					if (live?.transport !== "stdio" || live.command === command) {
						return;
					}
					// An empty command would make the loader drop the whole server, so it is refused and the old one is put back.
					const problem = await updateServer(host, serverId, (server) => server.transport === "stdio" ? { ...server, command } : server);
					if (problem) {
						text.setValue(live.command);
					}
					host.setFieldFeedback(setting, problem);
					paintStatus();
				});
			});
		});
		connection.addSetting((setting) => {
			host.prepareFieldFeedback(setting);
			setting.setName("Arguments").setDesc("One argument per line.").addTextArea((text) => {
				text.inputEl.rows = 4;
				host.labelControl(text.inputEl, "Arguments");
				text.setValue(formatArgsText(first.args));
				// Enter adds a line in this box, so only leaving the box saves.
				host.bindCommitOnBlur(text.inputEl, async () => {
					const typed = parseArgsText(text.getValue());
					const args = typed.slice(0, MAX_MCP_ARGS);
					await changeServer(host, serverId, (server) => server.transport === "stdio" ? { ...server, args } : server);
					host.setFieldFeedback(setting, typed.length > args.length ? `AskMate keeps the first ${MAX_MCP_ARGS} arguments.` : null, "info");
					paintStatus();
				}, false);
			});
		});
	} else {
		connection.addSetting((setting) => {
			host.prepareFieldFeedback(setting);
			setting.setName("Address").setDesc(ADDRESS_HELP).addText((text) => {
				host.labelControl(text.inputEl, "Server address");
				text.setPlaceholder("Server address").setValue(first.url);
				host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
					const url = text.getValue().trim();
					const live = currentServer(host, serverId);
					if (live?.transport !== "http" || live.url === url) {
						return;
					}
					// An address the loader cannot keep would drop the whole server, so it is refused and the old one is put back.
					const problem = await updateServer(host, serverId, (server) => server.transport === "http" ? { ...server, url } : server);
					if (problem) {
						text.setValue(live.url);
					}
					const saved = currentServer(host, serverId);
					host.setFieldFeedback(setting, problem ?? (saved ? validateServerConfig(saved)[0] ?? null : null));
					paintStatus();
				});
			});
		});
		connection.addSetting((setting) => {
			host.prepareFieldFeedback(setting);
			const existing = first.bearerSecretId;
			setting.setName("Bearer token").setDesc(existing
				? (existing.startsWith(`${MCP_SECRET_PREFIX}${serverId}-`)
					? "A token is stored in your system keychain. Paste a new one to replace it."
					: `This server uses the stored secret "${existing}", which AskMate did not create for it. The trust dialog warns about this.`)
				: "Optional. Saved in your system keychain, never in your vault.");
			let input: HTMLInputElement | null = null;
			setting.addText((text) => {
				input = text.inputEl;
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				host.labelControl(text.inputEl, "Bearer token");
				text.setPlaceholder(existing ? "Paste a new token to replace it" : "Paste a token");
			});
			setting.addButton((button) => {
				button.setButtonText("Save token").onClick(() => {
					void host.runSettingAction(async () => {
						const value = input?.value.trim() ?? "";
						if (!value) {
							host.setFieldFeedback(setting, "Paste the token first.");
							return;
						}
						const previousId = bearerIdOf(currentServer(host, serverId));
						const id = chooseServerSecretId(serverId, "token", previousId ?? undefined);
						writeSecret(app, id, value);
						await changeServer(host, serverId, (server) => server.transport === "http" ? { ...server, bearerSecretId: id } : server);
						if (input) {
							input.value = "";
						}
						host.setFieldFeedback(setting, describeTokenSaved(previousId, id), "success");
						paintStatus();
					});
				});
			});
			if (existing) {
				setting.addExtraButton((button) => {
					host.describeExtraButton(button.setIcon("trash"), "Remove the bearer token");
					button.onClick(() => {
						void host.runSettingAction(async () => {
							const id = bearerIdOf(currentServer(host, serverId));
							if (id?.startsWith(`${MCP_SECRET_PREFIX}${serverId}-`)) {
								writeSecret(app, id, "");
							}
							await changeServer(host, serverId, (server) => server.transport === "http" ? { ...server, bearerSecretId: null } : server);
							refresh();
						});
					});
				});
			}
		});
	}

	// --- Variables or headers -------------------------------------------------------------------------------------------
	const kind = first.transport === "stdio" ? "env" : "header";
	renderValueMap(host, containerEl, serverId, kind, refresh, paintStatus);

	// --- Permissions ----------------------------------------------------------------------------------------------------
	const permissions = new SettingGroup(containerEl).setHeading("Permissions");
	let readOnlyToggle: ToggleComponent | null = null;
	permissions.addSetting((setting) => {
		setting.setName("Approval").setDesc(APPROVAL_HELP[first.approval]).addDropdown((dropdown) => {
			host.labelControl(dropdown.selectEl, "Approval mode");
			dropdown.addOptions({ ...APPROVAL_LABELS }).setValue(first.approval).onChange(async (value) => {
				const approval = (Object.keys(APPROVAL_LABELS) as McpApprovalMode[]).find((mode) => mode === value) ?? "always-ask";
				setting.setDesc(APPROVAL_HELP[approval]);
				readOnlyToggle?.setDisabled(approval !== "trusted-read-only");
				await host.runSettingAction(() => changeServer(host, serverId, (server) => ({ ...server, approval })));
			});
		});
	});
	permissions.addSetting((setting) => {
		setting.setName("Believe the server's read-only labels").setDesc("Only used when approval is set to ask unless the tool only reads. A server can claim anything, so leave this off unless you trust it.");
		setting.addToggle((toggle) => {
			readOnlyToggle = toggle;
			host.setupToggle(toggle, "Believe the server's read-only labels", first.trustsAnnotations, async (value) => {
				await host.runSettingAction(() => changeServer(host, serverId, (server) => ({ ...server, trustsAnnotations: value })));
			});
			toggle.setDisabled(first.approval !== "trusted-read-only");
		});
	});

	// --- Tools ----------------------------------------------------------------------------------------------------------
	const toolsGroup = containerEl.createDiv({ cls: "askmate-mcp-tools" });
	const renderTools = (): void => {
		toolsGroup.empty();
		const live = currentServer(host, serverId);
		if (!live) {
			return;
		}
		const group = new SettingGroup(toolsGroup).setHeading("Tools");
		const known = (host.plugin.mcpService?.snapshotTools().tools ?? []).filter((tool) => tool.serverId === serverId);
		const turnedOff = (live.disabledTools ?? []).filter((name) => !known.some((tool) => tool.toolName === name));
		if (known.length === 0 && turnedOff.length === 0) {
			group.addSetting((setting) => {
				setting.setName("No tools to show yet").setDesc("Trust and test the server to load its tools. You can then turn off any tool you do not want the model to use.");
			});
			return;
		}
		const rows = [
			...known.map((tool) => ({ name: tool.toolName, title: tool.title, description: tool.description, warnings: tool.warnings, changed: tool.pin === "changed", readOnly: tool.claimsReadOnly })),
			...turnedOff.map((name) => ({ name, title: name, description: "This tool is turned off, so the model never sees it.", warnings: [] as readonly string[], changed: false, readOnly: false }))
		];
		for (const tool of rows) {
			group.addSetting((setting) => {
				setting.setName(tool.title).setDesc(`${tool.name} · ${tool.description.replace(/\s+/g, " ").slice(0, 160)}`);
				if (tool.changed) {
					setting.controlEl.createSpan({ cls: statusChipClass("warning"), text: "Changed" });
				}
				if (tool.readOnly) {
					setting.controlEl.createSpan({ cls: statusChipClass("off"), text: "Says read-only" });
				}
				for (const warning of tool.warnings) {
					setting.descEl.createDiv({ cls: "askmate-settings-callout is-warning", text: `Warning: ${warning}.` });
				}
				setting.addToggle((toggle) => {
					const focusKey = `tool:${serverId}:${tool.name}`;
					host.setupToggle(toggle, `Let the model use ${tool.title}`, !(live.disabledTools ?? []).includes(tool.name), async (allowed) => {
						// Saving tells the service, which redraws this list, so the switch asks for its focus back.
						host.focusAfterRebuild = focusKey;
						await host.runSettingAction(() => changeServer(host, serverId, (server) => ({ ...server, disabledTools: setToolAllowed(server.disabledTools, tool.name, allowed) })));
					});
					if (host.focusAfterRebuild === focusKey) {
						host.focusAfterRebuild = null;
						toggle.toggleEl.focus();
					}
				});
			});
		}
	};
	renderTools();

	// --- Status updates while the page is open --------------------------------------------------------------------------
	const unsubscribe = host.plugin.mcpService?.onStatusChange(() => {
		paintStatus();
		renderTools();
	});
	hide.run = () => {
		unsubscribe?.();
		hide.run = () => undefined;
	};
}

/** Environment variables for a local program, or headers for a remote server: plain values in the open, secrets in the keychain. */
function renderValueMap(host: SettingsPageHost, containerEl: HTMLElement, serverId: string, kind: "env" | "header", refresh: () => void, onChange: () => void): void {
	const { app } = host;
	const noun = kind === "env" ? "variable" : "header";
	const read = (): Record<string, McpEnvValue> => {
		const server = currentServer(host, serverId);
		return server?.transport === "stdio" ? server.env : server?.transport === "http" ? server.headers : {};
	};
	const write = (values: Record<string, McpEnvValue>): Promise<void> => changeServer(host, serverId, (server) =>
		server.transport === "stdio" ? { ...server, env: values } : server.transport === "http" ? { ...server, headers: values } : server);

	const group = new SettingGroup(containerEl).setHeading(kind === "env" ? "Environment variables" : "Headers");
	for (const [name, value] of Object.entries(read())) {
		group.addSetting((setting) => {
			host.prepareFieldFeedback(setting);
			setting.setName(name);
			setting.setDesc(value.kind === "secret" ? `Stored secret "${value.secretId}". Paste a new value to replace it.` : "Visible value.");
			setting.addText((text) => {
				host.labelControl(text.inputEl, `${name} value`);
				if (value.kind === "secret") {
					text.inputEl.type = "password";
					text.inputEl.autocomplete = "off";
					text.setPlaceholder("Paste a new value");
				} else {
					text.setValue(value.value);
				}
				host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
					const entered = text.getValue();
					if (value.kind === "secret") {
						if (!entered) {
							return;
						}
						// A secret AskMate did not make for this server may be the AI provider key or another plugin's token, so a new
						// value goes under a name of its own and the entry points there, instead of overwriting the other secret.
						const id = chooseServerSecretId(serverId, name, value.secretId);
						writeSecret(app, id, entered);
						if (id !== value.secretId) {
							await write({ ...read(), [name]: { kind: "secret", secretId: id } });
							refresh();
						}
						text.setValue("");
						host.setFieldFeedback(setting, "Replaced the stored secret.", "success");
						return;
					}
					const plan = planVariable({ kind, serverId, name, value: entered, asSecret: false });
					if (!plan.ok) {
						host.setFieldFeedback(setting, plan.message);
						text.setValue(value.value);
						return;
					}
					if (plan.secret) {
						writeSecret(app, plan.secret.id, plan.secret.value);
					}
					await write({ ...read(), [name]: plan.value });
					if (plan.forcedSecret) {
						host.setFieldFeedback(setting, "That looks like a credential, so AskMate stored it in your keychain.", "info");
						refresh();
					}
					onChange();
				});
			});
			setting.addExtraButton((button) => {
				host.describeExtraButton(button.setIcon("trash"), `Remove ${name}`);
				button.onClick(() => {
					void host.runSettingAction(async () => {
						if (value.kind === "secret" && value.secretId.startsWith(`${MCP_SECRET_PREFIX}${serverId}-`)) {
							writeSecret(app, value.secretId, "");
						}
						await write(Object.fromEntries(Object.entries(read()).filter(([key]) => key !== name)));
						refresh();
					});
				});
			});
		});
	}

	group.addSetting((setting) => {
		host.prepareFieldFeedback(setting);
		setting.setName(`Add a ${noun}`).setDesc(kind === "env" ? "Names such as API_KEY or a token are stored in your keychain automatically." : "Authorization-style headers are stored in your keychain automatically.");
		let nameInput = "";
		let valueEl: HTMLInputElement | null = null;
		let asSecret = false;
		setting.addText((text) => {
			host.labelControl(text.inputEl, `${noun} name`);
			text.setPlaceholder("Name").onChange((value) => {
				nameInput = value;
				if (valueEl && isSensitiveName(value)) {
					valueEl.type = "password";
				}
			});
		});
		setting.addText((text) => {
			valueEl = text.inputEl;
			host.labelControl(text.inputEl, `${noun} value`);
			text.inputEl.autocomplete = "off";
			text.setPlaceholder("Value");
		});
		setting.addToggle((toggle) => {
			host.setupToggle(toggle, `Store this ${noun} as a secret`, false, (value) => {
				asSecret = value;
				if (valueEl) {
					valueEl.type = value ? "password" : "text";
				}
			});
		});
		setting.addButton((button) => {
			button.setButtonText("Add").onClick(() => {
				void host.runSettingAction(async () => {
					const plan = planVariable({ kind, serverId, name: nameInput, value: valueEl?.value ?? "", asSecret, existingSecretId: undefined });
					if (!plan.ok) {
						host.setFieldFeedback(setting, plan.message);
						return;
					}
					if (plan.secret) {
						writeSecret(app, plan.secret.id, plan.secret.value);
					}
					await write({ ...read(), [plan.name]: plan.value });
					if (plan.forcedSecret) {
						new Notice(`AskMate stored ${plan.name} in your keychain because it looks like a credential.`);
					}
					refresh();
				});
			});
		});
	});
}
