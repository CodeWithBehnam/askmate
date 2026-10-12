/**
 * Everything McpService needs from the outside, built from Obsidian's own services: requestUrl for HTTP, SecretStorage for
 * secrets, app local storage for device-local trust, and the desktop-only launcher for local servers. The decisions
 * (what to approve, what to trust) stay in McpService; this file only connects it.
 */
import type { ApprovalChoice, DeviceTrustStore, McpHost, McpSecrets, McpSettings, ToolApprovalCard, TrustRequest } from "../mcp";
import type { HttpRequestFn } from "../mcp/httpTransport";
import type { LaunchRequest } from "../mcp/spawnPlan";
import type { ChildLike } from "../mcp/stdioTransport";
import { toUiApprovalCard } from "../requests/toolRun";
import type { ToolApprovalCard as UiApprovalCard, ToolApprovalChoice } from "../requests/runTypes";
import type { ToolApprovalModalInput } from "../ui/modals/ToolApprovalModal";

/** What launch.ts provides. Loaded on demand, and only on desktop. */
export interface LaunchModule {
	spawnChild(request: LaunchRequest): ChildLike;
	resolveLoginPath(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): Promise<string | null>;
}

export interface ObsidianResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export interface ObsidianRequestParams {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	throw: false;
}

/** requestUrl cannot be cancelled and buffers the body, which is why MCP over HTTP uses buffered replies. */
export function createHttpRequest(send: (params: ObsidianRequestParams) => Promise<ObsidianResponse>): HttpRequestFn {
	return async (request) => {
		const response = await send({
			url: request.url,
			method: request.method,
			headers: { ...request.headers },
			...(request.body === undefined ? {} : { body: request.body }),
			throw: false
		});
		// The transport matches header names in lower case.
		const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
		return { status: response.status, headers, text: response.text };
	};
}

interface LocalStorageApp {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, data: unknown): void;
}

const TRUST_PREFIX = "askmate-mcp-trust:";

/** Trust lives in the device's local storage and not in data.json, because data.json syncs and a synced definition must not arrive trusted. */
export function createDeviceTrustStore(app: LocalStorageApp): DeviceTrustStore {
	return {
		get: (key) => {
			const value = app.loadLocalStorage(`${TRUST_PREFIX}${key}`);
			return typeof value === "string" ? value : null;
		},
		set: (key, value) => {
			app.saveLocalStorage(`${TRUST_PREFIX}${key}`, value);
		},
		remove: (key) => {
			app.saveLocalStorage(`${TRUST_PREFIX}${key}`, null);
		}
	};
}

export function createSecretReader(storage: { getSecret(id: string): string | null }): McpSecrets {
	return { get: (id) => storage.getSecret(id) };
}

/**
 * Routes the per-call approval card to whoever started the run. McpService passes the run's signal to its host, so the
 * signal is the key: two runs at once never see each other's cards. A call with nobody registered is refused, and a
 * stopped run refuses at once.
 */
export class McpApprovalRouter {
	private readonly handlers = new Map<AbortSignal, (card: UiApprovalCard) => Promise<ToolApprovalChoice>>();

	register(signal: AbortSignal, handler: (card: UiApprovalCard) => Promise<ToolApprovalChoice>): () => void {
		this.handlers.set(signal, handler);
		return () => {
			if (this.handlers.get(signal) === handler) {
				this.handlers.delete(signal);
			}
		};
	}

	async confirm(card: ToolApprovalCard, signal: AbortSignal): Promise<ApprovalChoice> {
		const handler = this.handlers.get(signal);
		if (!handler || signal.aborted) {
			return "deny";
		}
		const answer = handler(toUiApprovalCard(card));
		const stopped = new Promise<ApprovalChoice>((resolve) => {
			signal.addEventListener("abort", () => resolve("deny"), { once: true });
		});
		const choice = await Promise.race([answer, stopped]);
		return choice === "allow-once" || choice === "allow-chat" ? choice : "deny";
	}
}

/**
 * The approval card of a run that brings no inline card of its own, as the approval dialog takes it. The arguments stay the full
 * JSON the server will receive. A card that does not say it may be granted for the chat offers only "Allow once".
 */
export function toApprovalDialogInput(card: UiApprovalCard): ToolApprovalModalInput {
	return {
		serverLabel: card.server,
		toolName: card.tool,
		...(card.title ? { toolTitle: card.title } : {}),
		argumentsText: card.argumentsJson,
		...(card.description ? { description: card.description } : {}),
		changedSinceApproval: card.changedSinceApproval,
		canAllowForChat: card.canAllowForChat === true
	};
}

function osOf(flags: { isWin: boolean; isMacOS: boolean }): NodeJS.Platform {
	return flags.isWin ? "win32" : flags.isMacOS ? "darwin" : "linux";
}

export interface McpHostDeps {
	version: string;
	getSettings: () => McpSettings;
	platform: { isDesktopApp: boolean; isWin: boolean; isMacOS: boolean };
	env: Readonly<Record<string, string | undefined>>;
	secrets: McpSecrets;
	deviceTrust: DeviceTrustStore;
	requestHttp: HttpRequestFn;
	/** The launcher, once loaded. Null before that, and always null off the desktop. */
	getLauncher: () => LaunchModule | null;
	approvals: McpApprovalRouter;
	confirmTrust: (request: TrustRequest) => Promise<boolean>;
	now?: () => number;
}

export function createMcpHost(deps: McpHostDeps): McpHost {
	const os = osOf(deps.platform);
	return {
		platform: { isDesktopApp: deps.platform.isDesktopApp, os, env: deps.env },
		identity: { name: "askmate", version: deps.version },
		settings: deps.getSettings,
		secrets: deps.secrets,
		deviceTrust: deps.deviceTrust,
		requestHttp: deps.requestHttp,
		launchProcess: (request) => {
			const launcher = deps.getLauncher();
			if (!launcher) {
				throw new Error("The launcher for local servers is not ready. Try again in a moment.");
			}
			return launcher.spawnChild(request);
		},
		resolveLoginPath: async () => {
			const launcher = deps.getLauncher();
			return launcher ? await launcher.resolveLoginPath(os, deps.env) : null;
		},
		confirmTrust: deps.confirmTrust,
		confirmCall: async (card, signal) => await deps.approvals.confirm(card, signal),
		clock: { now: deps.now ?? Date.now },
		logger: {
			warn: (message) => {
				console.warn(`AskMate MCP: ${message}`);
			},
			error: (message) => {
				console.error(`AskMate MCP: ${message}`);
			}
		}
	};
}
