import { DEFAULT_CLIENT_CONFIG, McpClient, type EraHint, type McpClientConfig, type ToolCatalogue } from "./McpClient";
import { type McpServerConfig, type McpSettings, type McpValue, findSecretRisks, trustHash, validateServerConfig } from "./config";
import { describeMcpError } from "./errors";
import type {
	ApprovalChoice,
	McpHost,
	McpServerState,
	McpServerStatus,
	SnapshotServer,
	SnapshotTool,
	ToolApprovalCard,
	ToolCallRequest,
	ToolFailureKind,
	ToolOutcome,
	ToolSnapshot,
	TrustRequest
} from "./host";
import { HttpTransport, validateServerUrl } from "./httpTransport";
import { McpClientError, type JsonObject, type McpTool, isJsonObject } from "./protocol";
import { redactMcpText } from "./redact";
import { buildChildEnv, findCommandRisks, formatCommandLine, planSpawn } from "./spawnPlan";
import { StdioTransport } from "./stdioTransport";
import {
	DEFAULT_OUTPUT_LIMITS,
	type Grant,
	type HostNoticeStatus,
	buildModelToolNames,
	decideApproval,
	findDescriptionWarnings,
	findSchemaWarnings,
	fingerprintTool,
	renderHostNotice,
	renderToolResult,
	revealInvisible,
	sanitiseDescription,
	sanitiseDisplayName,
	sanitiseSchema
} from "./toolPolicy";
import type { McpTransport } from "./transport";

/** A failed server is not retried by prepareRun for this long, so a missing command does not cost a timeout on every question. */
const FAILED_RETRY_MS = 15_000;
/** unload must not hang on a server that ignores stdin closing: after this the plugin lets go and the transport finishes in the background. */
const SHUTDOWN_DEADLINE_MS = 8_000;
/** OpenAI accepts 128 functions per request. Leave room for the plugin's own. */
const MAX_TOOLS_EXPOSED = 100;
const MAX_INSTRUCTION_CHARS = 2000;
const MAX_ARGUMENT_CHARS = 100_000;

interface ToolEntry {
	readonly tool: McpTool;
	readonly fingerprint: string;
	readonly title: string;
	readonly description: string;
	readonly originalDescription: string;
	readonly schema: JsonObject;
	readonly warnings: readonly string[];
}

interface Failure {
	readonly kind: McpClientError["kind"];
	readonly message: string;
	readonly fix: string | null;
}

interface Runtime {
	readonly serverId: string;
	/** Trust hash of the definition this runtime was started from. */
	readonly configHash: string;
	phase: "connecting" | "ready" | "failed";
	readonly abort: AbortController;
	transport: McpTransport | null;
	client: McpClient | null;
	entries: ReadonlyMap<string, ToolEntry>;
	entriesSource: ToolCatalogue | null;
	dropped: number;
	serverName: string;
	instructions: string | null;
	failure: Failure | null;
	failedAt: number;
	done: Promise<void>;
}

export type TrustOutcome =
	| { readonly kind: "trusted" }
	| { readonly kind: "declined" }
	| { readonly kind: "invalid"; readonly message: string };

const trustKey = (serverId: string): string => `server:${serverId}`;
const pinKey = (serverId: string, toolName: string): string => `tool:${serverId}:${toolName}`;
const grantKey = (serverId: string, toolName: string): string => `${serverId}\0${toolName}`;

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		Object.values(value as Record<string, unknown>).forEach((child) => {
			deepFreeze(child);
		});
	}
	return value;
}

/** Resolves when the work settles or the signal aborts, whichever is first. Never rejects: failures live in the runtime. */
function settleOrAbort(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		return work;
	}
	return new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const onAbort = (): void => resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		void work.then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

/** Arguments come from a model, so anything that cannot be serialised counts as too large instead of throwing. */
function serialisedLength(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** settings come from a file the user can edit, so a nonsense cap falls back to the default instead of cutting every result to nothing. */
function outputLimit(configured: number): number {
	return Number.isFinite(configured) && configured >= 500 ? Math.min(Math.floor(configured), 200_000) : DEFAULT_OUTPUT_LIMITS.maxChars;
}

function toClientError(error: unknown): McpClientError {
	return error instanceof McpClientError ? error : new McpClientError("protocol", error instanceof Error ? error.message : String(error));
}

/**
 * Orchestrates MCP servers for the plugin. Every side effect (HTTP, processes, secrets, local storage, dialogs, time, logging) comes
 * from the injected host, so the whole policy layer runs in tests with fakes.
 *
 * Lifecycle: nothing starts at construction or at plugin load. A server starts the first time a run needs its tools (prepareRun)
 * or the user presses Test connection, and only when MCP is enabled, the server is enabled and valid, and its definition is
 * trusted on this device. Any edit to the definition returns it to "needs-trust".
 *
 * For the plugin:
 * - status(), onStatusChange(): the chips for settings, the sidebar and the status bar.
 * - trust(), revokeTrust(), testConnection(): the settings page actions.
 * - prepareRun(signal): at the start of a tool-using run. Returns the frozen ToolSnapshot the run keeps.
 * - callTool(request, signal): from the tool loop, once per model-requested call. Always resolves; `text` goes back to the model.
 * - reconcile(): after settings change. forgetChat(id): when a conversation ends. shutdown(): await it in onunload.
 */
export class McpService {
	private readonly runtimes = new Map<string, Runtime>();
	private readonly chatGrants = new Map<string, Map<string, Grant>>();
	private readonly eraCache = new Map<string, EraHint>();
	private readonly listeners = new Set<() => void>();
	private loginPath: Promise<string | null> | null = null;
	private snapshotCounter = 0;
	private closed = false;

	constructor(private readonly host: McpHost) {}

	// Status ----------------------------------------------------------------------------------------------------------------

	/** One entry per configured server. Synchronous: it reads settings, device trust and what has already happened. */
	status(): readonly McpServerStatus[] {
		const settings = this.host.settings();
		return settings.servers.map((server) => this.statusOf(settings, server));
	}

	private statusOf(settings: McpSettings, server: McpServerConfig): McpServerStatus {
		return { id: server.id, label: server.label, transport: server.transport, state: this.stateOf(settings, server) };
	}

	private stateOf(settings: McpSettings, server: McpServerConfig): McpServerState {
		if (!settings.enabled || !server.enabled || this.closed) {
			return { kind: "off" };
		}
		if (server.transport === "stdio" && !this.host.platform.isDesktopApp) {
			return { kind: "error", error: "unsupported", message: "Local servers only run in the desktop app.", fix: null };
		}
		const problems = validateServerConfig(server);
		if (problems.length > 0) {
			return { kind: "error", error: "unsupported", message: problems[0] ?? "The server settings are not valid.", fix: "Change the server settings." };
		}
		const hash = trustHash(server);
		if (this.host.deviceTrust.get(trustKey(server.id)) !== hash) {
			return { kind: "needs-trust" };
		}
		const runtime = this.runtimes.get(server.id);
		if (!runtime || runtime.configHash !== hash) {
			return { kind: "idle" };
		}
		switch (runtime.phase) {
			case "connecting":
				return { kind: "connecting" };
			case "ready": {
				const disabled = runtime.entries.size - this.visibleEntries(server, runtime).length;
				return {
					kind: "ready",
					tools: this.visibleEntries(server, runtime).length,
					hidden: runtime.dropped + disabled,
					era: runtime.client?.session.era ?? "legacy",
					version: runtime.client?.session.version ?? "",
					serverName: runtime.serverName
				};
			}
			case "failed": {
				const failure = runtime.failure;
				if (failure?.kind === "auth_required") {
					return { kind: "needs-auth", hint: failure.message };
				}
				return { kind: "error", error: failure?.kind ?? "transport", message: failure?.message ?? "The server stopped.", fix: failure?.fix ?? null };
			}
		}
	}

	/** Calls back after any change a status chip could show. Returns an unsubscribe function. */
	onStatusChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(): void {
		[...this.listeners].forEach((listener) => {
			try {
				listener();
			} catch (error) {
				this.host.logger.error(`MCP status listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}

	// Trust -----------------------------------------------------------------------------------------------------------------

	private findServer(serverId: string): McpServerConfig | undefined {
		return this.host.settings().servers.find((server) => server.id === serverId);
	}

	private buildTrustRequest(server: McpServerConfig, reason: "first-use" | "changed"): TrustRequest {
		if (server.transport === "stdio") {
			const envNames = Object.keys(server.env);
			return {
				transport: "stdio",
				serverId: server.id,
				label: server.label,
				reason,
				commandLine: formatCommandLine(server.command, server.args),
				command: server.command,
				args: [...server.args],
				env: envNames.map((name) => {
					const value = server.env[name];
					return value.kind === "plain"
						? { name, value: value.value, secret: false, secretId: null }
						: { name, value: "", secret: true, secretId: value.secretId };
				}),
				risks: [
					...findCommandRisks({ command: server.command, args: server.args, envNames }),
					...findSecretRisks(server, `the program "${server.command}"`)
				]
			};
		}
		const host = new URL(server.url).host;
		return {
			transport: "http",
			serverId: server.id,
			label: server.label,
			reason,
			url: server.url,
			host,
			headerNames: Object.keys(server.headers),
			hasBearerToken: server.bearerSecretId !== null,
			bearerSecretId: server.bearerSecretId,
			secretHeaders: Object.keys(server.headers).flatMap((name) => {
				const value = server.headers[name];
				return value.kind === "secret" ? [{ name, secretId: value.secretId }] : [];
			}),
			risks: findSecretRisks(server, host)
		};
	}

	/** Asks the person to trust this definition on this device. Nothing starts without it, and any change to the definition asks again. */
	async trust(serverId: string): Promise<TrustOutcome> {
		const server = this.findServer(serverId);
		if (!server) {
			return { kind: "invalid", message: "That server no longer exists." };
		}
		if (server.transport === "stdio" && !this.host.platform.isDesktopApp) {
			return { kind: "invalid", message: "Local servers only run in the desktop app." };
		}
		const problems = validateServerConfig(server);
		if (problems.length > 0) {
			return { kind: "invalid", message: problems[0] ?? "The server settings are not valid." };
		}
		const hash = trustHash(server);
		const previous = this.host.deviceTrust.get(trustKey(server.id));
		if (previous === hash) {
			return { kind: "trusted" };
		}
		const accepted = await this.host.confirmTrust(this.buildTrustRequest(server, previous === null ? "first-use" : "changed"));
		// Strict: a dialog that resolves with anything but `true` (a dismissed one often gives undefined) is not trust.
		if (accepted !== true) {
			return { kind: "declined" };
		}
		// The dialog may have been open while settings changed. Trust only what the person actually saw.
		const current = this.findServer(serverId);
		if (!current || trustHash(current) !== hash) {
			return { kind: "invalid", message: "The server settings changed while the dialog was open. Review them and try again." };
		}
		this.host.deviceTrust.set(trustKey(server.id), hash);
		this.emit();
		return { kind: "trusted" };
	}

	/** Forgets trust for a server and stops it. The next start asks again. */
	async revokeTrust(serverId: string): Promise<void> {
		this.host.deviceTrust.remove(trustKey(serverId));
		const runtime = this.runtimes.get(serverId);
		if (runtime) {
			await this.dispose(runtime);
		}
		this.emit();
	}

	// Connecting ------------------------------------------------------------------------------------------------------------

	private clientConfig(): McpClientConfig {
		return { ...DEFAULT_CLIENT_CONFIG, ...this.host.tuning?.client, identity: this.host.identity, now: () => this.host.clock.now() };
	}

	private getLoginPath(): Promise<string | null> {
		this.loginPath ??= this.host.resolveLoginPath();
		return this.loginPath;
	}

	/** Every secret value this server uses right now, for masking text built from its failures. */
	private secretValues(server: McpServerConfig): string[] {
		const values = server.transport === "stdio" ? server.env : server.headers;
		const fromValues = Object.values(values).flatMap((value) => {
			const secret = value.kind === "secret" ? this.host.secrets.get(value.secretId) : null;
			return secret ? [secret] : [];
		});
		const token = server.transport === "http" && server.bearerSecretId ? this.host.secrets.get(server.bearerSecretId) : null;
		return [...fromValues, ...(token ? [token] : [])];
	}

	private resolveValues(server: McpServerConfig, values: Readonly<Record<string, McpValue>>): Record<string, string> {
		return Object.fromEntries(
			Object.entries(values).map(([name, value]) => {
				if (value.kind === "plain") {
					return [name, value.value];
				}
				const secret = this.host.secrets.get(value.secretId);
				if (secret === null) {
					throw new McpClientError("unsupported", `The secret for "${name}" is not set. Add it in the settings for ${server.label}.`);
				}
				return [name, secret];
			})
		);
	}

	private async buildTransport(server: McpServerConfig): Promise<McpTransport> {
		if (server.transport === "stdio") {
			const env = this.resolveValues(server, server.env);
			const plan = planSpawn({ command: server.command, args: server.args, env }, this.host.platform.os);
			const child = this.host.launchProcess({ plan, env: buildChildEnv(this.host.platform.env, await this.getLoginPath(), env) });
			return new StdioTransport(child, { secrets: this.secretValues(server), graceMs: this.host.tuning?.stdioGraceMs });
		}
		const url = validateServerUrl(server.url);
		const headers = server.headers;
		// Fail on an unset header secret now, with a clear message, rather than on the first request.
		this.resolveValues(server, headers);
		// Bearer token and header secrets are read again for every request, so a token replaced in settings applies at once.
		const auth = (): string | null => {
			const token = server.bearerSecretId ? this.host.secrets.get(server.bearerSecretId) : null;
			return token ? `Bearer ${token}` : null;
		};
		const extra = (): Record<string, string> =>
			Object.fromEntries(
				Object.entries(headers).flatMap(([name, value]) => {
					const resolved = value.kind === "plain" ? value.value : this.host.secrets.get(value.secretId);
					// A value with a line break could inject a second header, so it is not sent at all.
					return resolved !== null && !/[\0\r\n]/.test(resolved) ? [[name, resolved] as const] : [];
				})
			);
		return new HttpTransport(url, this.host.requestHttp, auth, extra);
	}

	private failureOf(error: unknown, server: McpServerConfig): Failure {
		const clientError = toClientError(error);
		const copy = describeMcpError(clientError, this.secretValues(server));
		return { kind: clientError.kind, message: copy.message, fix: copy.fix };
	}

	private start(server: McpServerConfig, configHash: string): Runtime {
		const runtime: Runtime = {
			serverId: server.id,
			configHash,
			phase: "connecting",
			abort: new AbortController(),
			transport: null,
			client: null,
			entries: new Map(),
			entriesSource: null,
			dropped: 0,
			serverName: server.label,
			instructions: null,
			failure: null,
			failedAt: 0,
			done: Promise.resolve()
		};
		runtime.done = this.connect(runtime, server);
		this.runtimes.set(server.id, runtime);
		this.emit();
		return runtime;
	}

	/** Never rejects. A failure is recorded on the runtime so status() can show it and prepareRun can carry on with the other servers. */
	private async connect(runtime: Runtime, server: McpServerConfig): Promise<void> {
		try {
			runtime.transport = await this.buildTransport(server);
			const client = await McpClient.connect(runtime.transport, this.clientConfig(), runtime.abort.signal, this.eraCache.get(runtime.configHash));
			runtime.client = client;
			this.eraCache.set(runtime.configHash, { era: client.session.era, version: client.session.version });
			runtime.serverName = sanitiseDisplayName(client.session.serverName) || server.label;
			runtime.instructions = client.session.instructions === null ? null : sanitiseDescription(client.session.instructions, MAX_INSTRUCTION_CHARS) || null;
			await this.readCatalogue(runtime, runtime.abort.signal);
			runtime.phase = "ready";
		} catch (error) {
			await this.fail(runtime, server, error);
		}
		this.emit();
	}

	/** Reads the tool list (cheap when still fresh) and rebuilds fingerprints and sanitised copies when it changed. */
	private async readCatalogue(runtime: Runtime, signal: AbortSignal | undefined): Promise<void> {
		const client = runtime.client;
		if (!client) {
			return;
		}
		const catalogue = await client.listTools(signal);
		if (runtime.entriesSource === catalogue) {
			return;
		}
		runtime.entries = new Map(
			catalogue.tools.map((tool): [string, ToolEntry] => [
				tool.name,
				{
					tool,
					fingerprint: fingerprintTool(tool),
					title: sanitiseDisplayName(tool.title ?? tool.annotations?.title ?? tool.name),
					description: sanitiseDescription(tool.description),
					originalDescription: revealInvisible(tool.description ?? ""),
					schema: sanitiseSchema(tool.inputSchema),
					warnings: [...findDescriptionWarnings(tool.description), ...findSchemaWarnings(tool.inputSchema)]
				}
			])
		);
		runtime.entriesSource = catalogue;
		runtime.dropped = catalogue.dropped;
	}

	private async fail(runtime: Runtime, server: McpServerConfig, error: unknown): Promise<void> {
		const failure = this.failureOf(error, server);
		runtime.failure = failure;
		runtime.phase = "failed";
		runtime.failedAt = this.host.clock.now();
		if (failure.kind !== "aborted") {
			this.host.logger.warn(`MCP server ${server.id}: ${failure.message}`);
		}
		const transport = runtime.transport;
		runtime.client = null;
		runtime.transport = null;
		if (transport) {
			await transport.close().catch((closeError: unknown) => {
				this.host.logger.warn(`MCP server ${server.id}: closing after a failure also failed: ${redactMcpText(closeError instanceof Error ? closeError.message : String(closeError), this.secretValues(server))}`);
			});
		}
	}

	private async dispose(runtime: Runtime): Promise<void> {
		if (this.runtimes.get(runtime.serverId) === runtime) {
			this.runtimes.delete(runtime.serverId);
		}
		runtime.abort.abort();
		await runtime.done;
		const transport = runtime.transport;
		const client = runtime.client;
		runtime.client = null;
		runtime.transport = null;
		runtime.phase = "failed";
		runtime.failure ??= { kind: "aborted", message: "Stopped.", fix: null };
		if (client) {
			await client.close();
		} else if (transport) {
			await transport.close();
		}
	}

	/** Enabled, usable on this platform, valid and trusted on this device. The only gate between a definition and a process or a request. */
	private isRunnable(settings: McpSettings, server: McpServerConfig): boolean {
		return settings.enabled
			&& server.enabled
			&& !this.closed
			&& (server.transport !== "stdio" || this.host.platform.isDesktopApp)
			&& validateServerConfig(server).length === 0
			&& this.host.deviceTrust.get(trustKey(server.id)) === trustHash(server);
	}

	/** Starts (or reuses) the connection for one server if it is allowed to run. Never throws. */
	private async ensure(server: McpServerConfig, signal: AbortSignal | undefined, force: boolean): Promise<void> {
		if (!this.isRunnable(this.host.settings(), server)) {
			return;
		}
		const hash = trustHash(server);
		let runtime = this.runtimes.get(server.id);
		if (runtime && runtime.configHash !== hash) {
			await this.dispose(runtime);
			runtime = undefined;
		}
		if (runtime?.phase === "failed") {
			if (!force && this.host.clock.now() - runtime.failedAt < (this.host.tuning?.failedRetryMs ?? FAILED_RETRY_MS)) {
				return;
			}
			await this.dispose(runtime);
			runtime = undefined;
		}
		const active = runtime ?? this.start(server, hash);
		await settleOrAbort(active.done, signal);
		if (active.phase === "ready" && !signal?.aborted) {
			try {
				await this.readCatalogue(active, signal);
			} catch (error) {
				// Stop is not a server fault. The earlier catalogue is intact, so the server stays ready and reusable; failing it would
				// kill a healthy process and leave the next question without its tools for the retry window.
				if (signal?.aborted || (error instanceof McpClientError && error.kind === "aborted")) {
					return;
				}
				// A server we cannot re-read may have changed its tools, so it sits out until it answers again.
				await this.fail(active, server, error);
			}
			this.emit();
		}
	}

	/**
	 * Starts every enabled, trusted server that is not running, refreshes tool lists that expired, and returns the snapshot for
	 * a run. Servers that fail do not fail the run: they appear under `unavailable`.
	 */
	async prepareRun(signal?: AbortSignal): Promise<ToolSnapshot> {
		// Stops anything that was edited, removed or switched off since the last run, even if the caller forgot to reconcile.
		if ((await this.stopStale()) > 0) {
			this.emit();
		}
		const settings = this.host.settings();
		if (settings.enabled && !this.closed) {
			await Promise.all(settings.servers.map((server) => this.ensure(server, signal, false).catch((error: unknown) => {
				// One server's unexpected failure must not take the other servers or the run with it.
				this.host.logger.error(`MCP server ${server.id} could not be prepared: ${redactMcpText(error instanceof Error ? error.message : String(error), this.secretValues(server))}`);
			})));
		}
		return this.snapshotTools();
	}

	/** "Test connection": asks for trust if needed, restarts the server and reports the resulting status. */
	async testConnection(serverId: string, signal?: AbortSignal): Promise<McpServerStatus | null> {
		const server = this.findServer(serverId);
		if (!server) {
			return null;
		}
		const outcome = await this.trust(serverId);
		const current = this.findServer(serverId);
		if (outcome.kind === "trusted" && current && !this.closed) {
			const existing = this.runtimes.get(serverId);
			if (existing) {
				await this.dispose(existing);
			}
			await this.ensure(current, signal, true);
		}
		const latest = this.findServer(serverId) ?? server;
		return this.statusOf(this.host.settings(), latest);
	}

	/** Stops servers whose definition was removed, disabled or edited, and forgets eras learnt for definitions that are gone. Returns how many it stopped. */
	private async stopStale(): Promise<number> {
		const settings = this.host.settings();
		const live = new Map(settings.servers.map((server) => [server.id, server] as const));
		const stale = [...this.runtimes.values()].filter((runtime) => {
			const server = live.get(runtime.serverId);
			return !settings.enabled || !server || !server.enabled || trustHash(server) !== runtime.configHash || this.host.deviceTrust.get(trustKey(server.id)) !== runtime.configHash;
		});
		await Promise.all(stale.map((runtime) => this.dispose(runtime)));
		const hashes = new Set(settings.servers.map((server) => trustHash(server)));
		[...this.eraCache.keys()].filter((key) => !hashes.has(key)).forEach((key) => this.eraCache.delete(key));
		return stale.length;
	}

	/** Call after settings change: stops what no longer matches and tells listeners to redraw their chips. */
	async reconcile(): Promise<void> {
		await this.stopStale();
		this.emit();
	}

	// Tools -----------------------------------------------------------------------------------------------------------------

	private visibleEntries(server: McpServerConfig, runtime: Runtime): ToolEntry[] {
		const disabled = new Set(server.disabledTools ?? []);
		return [...runtime.entries.values()].filter((entry) => !disabled.has(entry.tool.name));
	}

	/** The tools available right now, frozen. A run keeps this object, so later list changes never alter it. */
	snapshotTools(): ToolSnapshot {
		const settings = this.host.settings();
		const ready: Array<{ server: McpServerConfig; runtime: Runtime; entries: ToolEntry[] }> = [];
		const unavailable: McpServerStatus[] = [];
		if (settings.enabled && !this.closed) {
			for (const server of settings.servers.filter((candidate) => candidate.enabled)) {
				const status = this.statusOf(settings, server);
				const runtime = this.runtimes.get(server.id);
				if (status.state.kind === "ready" && runtime) {
					ready.push({ server, runtime, entries: this.visibleEntries(server, runtime) });
				} else {
					unavailable.push(status);
				}
			}
		}

		const refs = ready.flatMap(({ server, entries }) => entries.map((entry) => ({ serverId: server.id, toolName: entry.tool.name })));
		const names = buildModelToolNames(refs);
		const modelNameOf = new Map([...names.entries()].map(([modelName, ref]) => [grantKey(ref.serverId, ref.toolName), modelName] as const));

		const tools: SnapshotTool[] = ready.flatMap(({ server, entries }) =>
			entries.flatMap((entry): SnapshotTool[] => {
				const modelName = modelNameOf.get(grantKey(server.id, entry.tool.name));
				if (modelName === undefined) {
					return [];
				}
				const pinned = this.host.deviceTrust.get(pinKey(server.id, entry.tool.name));
				return [{
					modelName,
					serverId: server.id,
					serverLabel: server.label,
					toolName: entry.tool.name,
					title: entry.title,
					description: entry.description,
					inputSchema: entry.schema,
					fingerprint: entry.fingerprint,
					warnings: entry.warnings,
					pin: pinned === null ? "new" : pinned === entry.fingerprint ? "approved" : "changed",
					claimsReadOnly: entry.tool.annotations?.readOnlyHint === true
				}];
			})
		).sort((a, b) => (a.modelName < b.modelName ? -1 : a.modelName > b.modelName ? 1 : 0));

		const exposed = tools.slice(0, MAX_TOOLS_EXPOSED);
		const servers: SnapshotServer[] = ready.map(({ server, runtime, entries }) => ({
			id: server.id,
			label: server.label,
			serverName: runtime.serverName,
			instructions: runtime.instructions,
			tools: entries.length,
			hidden: runtime.dropped + (runtime.entries.size - entries.length)
		}));

		this.snapshotCounter += 1;
		return deepFreeze({
			id: this.snapshotCounter,
			createdAt: this.host.clock.now(),
			tools: exposed,
			byModelName: new Map(exposed.map((tool) => [tool.modelName, tool] as const)),
			servers,
			unavailable,
			omitted: tools.length - exposed.length
		});
	}

	// Calls -----------------------------------------------------------------------------------------------------------------

	private outcome(
		tool: { serverLabel: string; toolName: string; toolTitle: string },
		status: ToolOutcome["status"],
		notice: HostNoticeStatus,
		modelMessage: string,
		extra: { message?: string; fix?: string | null; failure?: ToolFailureKind } = {}
	): ToolOutcome {
		return {
			status,
			text: renderHostNotice(tool.serverLabel, tool.toolName, notice, modelMessage),
			serverLabel: tool.serverLabel,
			toolName: tool.toolName,
			toolTitle: tool.toolTitle,
			message: extra.message ?? null,
			fix: extra.fix ?? null,
			failure: extra.failure ?? null
		};
	}

	/**
	 * Runs one model-requested tool call. Always resolves with an outcome whose `text` is the tool_result for the model, so the
	 * loop can answer every call exactly once. It never retries: a failed call may already have had its effect.
	 */
	async callTool(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome> {
		const tool = call.snapshot.byModelName.get(call.modelName);
		if (!tool) {
			return this.outcome(
				{ serverLabel: "unknown", toolName: sanitiseDisplayName(call.modelName), toolTitle: sanitiseDisplayName(call.modelName) },
				"failed",
				"error",
				"There is no tool with that name. Use only the tools you were given.",
				{ message: "The model asked for a tool that does not exist.", failure: "unknown_tool" }
			);
		}
		const subject = { serverLabel: tool.serverLabel, toolName: tool.toolName, toolTitle: tool.title };
		if (!isJsonObject(call.args) || serialisedLength(call.args) > MAX_ARGUMENT_CHARS) {
			return this.outcome(subject, "failed", "error", "The arguments must be a JSON object of reasonable size. Call the tool again with valid arguments.", {
				message: "The model sent arguments the tool cannot take.",
				failure: "invalid_arguments"
			});
		}
		const args = call.args;
		const settings = this.host.settings();
		const server = this.findServer(tool.serverId);
		const runtime = this.runtimes.get(tool.serverId);
		const live = server && runtime?.client && runtime.phase === "ready" && this.isRunnable(settings, server) && runtime.configHash === trustHash(server)
			&& !(server.disabledTools ?? []).includes(tool.toolName)
			? { server, runtime, client: runtime.client }
			: null;
		if (!live) {
			return this.outcome(subject, "failed", "error", "The server is not connected, so the tool could not run.", {
				message: `${tool.serverLabel} is not connected.`,
				fix: "Open the server settings and test the connection.",
				failure: "unavailable"
			});
		}
		const changed = (): ToolOutcome =>
			this.outcome(subject, "failed", "error", "The tool changed after this answer started, so it was not run.", {
				message: `${tool.toolName} changed on the server since this answer started.`,
				fix: "Ask again to use the updated tool.",
				failure: "changed"
			});
		const isCurrent = (): boolean => live.runtime.entries.get(tool.toolName)?.fingerprint === tool.fingerprint;
		if (!isCurrent()) {
			return changed();
		}

		const approval = await this.approve(call, tool, live.server, args, signal);
		if (approval.kind === "stopped") {
			return this.outcome(subject, "aborted", "stopped", "The user stopped this request before the tool ran.");
		}
		if (approval.kind === "denied") {
			return this.outcome(subject, "denied", "denied", "The user did not allow this tool call. Do not retry it; explain what you could not do.");
		}
		// Auto-allowed paths (a chat grant, a trusted read-only tool) never wait on a dialog, so Stop must be checked here too.
		if (signal.aborted) {
			return this.outcome(subject, "aborted", "stopped", "The user stopped this request before the tool ran.");
		}
		// The card can stay open for a long time. If the server was restarted or another run refreshed the tool list meanwhile,
		// what the person approved is not what would run.
		if (live.runtime.client !== live.client) {
			return this.outcome(subject, "failed", "error", "The server was restarted while waiting for approval, so the tool was not run.", {
				message: `${tool.serverLabel} was restarted while waiting for approval.`,
				fix: "Ask again to retry.",
				failure: "unavailable"
			});
		}
		if (!isCurrent()) {
			return changed();
		}

		try {
			const entry = live.runtime.entries.get(tool.toolName);
			const result = await live.client.callTool(tool.toolName, args, signal, { timeoutMs: live.server.callTimeoutMs });
			return {
				status: result.isError ? "tool_error" : "ok",
				text: renderToolResult(tool.serverLabel, tool.toolName, result, { maxChars: outputLimit(settings.maxOutputChars) }),
				serverLabel: tool.serverLabel,
				toolName: tool.toolName,
				toolTitle: entry?.title ?? tool.title,
				message: null,
				fix: null,
				failure: null
			};
		} catch (error) {
			return this.callFailed(error, subject, live.server, live.runtime, signal);
		}
	}

	private async callFailed(
		error: unknown,
		subject: { serverLabel: string; toolName: string; toolTitle: string },
		server: McpServerConfig,
		runtime: Runtime,
		signal: AbortSignal
	): Promise<ToolOutcome> {
		const clientError = toClientError(error);
		if (signal.aborted || clientError.kind === "aborted") {
			return this.outcome(subject, "aborted", "stopped", "The user stopped this request while the tool was running. Its effect is unknown.");
		}
		const copy = describeMcpError(clientError, this.secretValues(server));
		this.host.logger.warn(`MCP tool ${server.id}/${subject.toolName} failed (${clientError.kind}): ${copy.detail}`);
		if ((clientError.kind === "transport" && runtime.transport?.kind === "stdio") || clientError.kind === "auth_required") {
			// A dead process, or a token the server no longer accepts: show it on the chip and let the next run start clean.
			await this.fail(runtime, server, clientError);
			this.emit();
		}
		const modelMessages: Record<McpClientError["kind"], string> = {
			timeout: "The tool did not answer in time. It may or may not have run. Do not retry it; tell the user.",
			aborted: "The call was stopped.",
			transport: "The connection to the server failed. The tool may or may not have run. Do not retry it; tell the user.",
			protocol: "The server sent a reply AskMate could not use. Do not retry it; tell the user.",
			auth_required: "The server refused the stored token. Do not retry it; tell the user to check the token in settings.",
			input_required: "The tool needs an extra step that AskMate does not support. Do not retry it; tell the user.",
			server_error: "The server reported an error. Do not retry it unchanged; explain what went wrong.",
			unsupported: "The tool cannot be used with this server configuration. Tell the user."
		};
		return this.outcome(subject, "failed", "error", modelMessages[clientError.kind], { message: copy.message, fix: copy.fix, failure: clientError.kind });
	}

	private async approve(
		call: ToolCallRequest,
		tool: SnapshotTool,
		server: McpServerConfig,
		args: JsonObject,
		signal: AbortSignal
	): Promise<{ kind: "allowed" } | { kind: "denied" } | { kind: "stopped" }> {
		const key = grantKey(tool.serverId, tool.toolName);
		const pinned = this.host.deviceTrust.get(pinKey(tool.serverId, tool.toolName));
		const pinChanged = pinned !== null && pinned !== tool.fingerprint;
		const grant = call.chatId === null ? undefined : this.chatGrants.get(call.chatId)?.get(key);
		const entry = this.runtimes.get(tool.serverId)?.entries.get(tool.toolName);
		const decision = pinChanged
			? { kind: "ask" as const, reason: "changed" as const }
			: decideApproval({ mode: server.approval, tool: entry?.tool ?? {}, fingerprint: tool.fingerprint, grant, trustsAnnotations: server.trustsAnnotations });

		if (decision.kind === "allow") {
			if (pinned === null) {
				this.host.deviceTrust.set(pinKey(tool.serverId, tool.toolName), tool.fingerprint);
			}
			return { kind: "allowed" };
		}

		const card: ToolApprovalCard = {
			serverId: tool.serverId,
			serverLabel: tool.serverLabel,
			toolName: tool.toolName,
			toolTitle: tool.title,
			argumentsText: JSON.stringify(args, null, 2),
			warnings: tool.warnings,
			description: entry?.originalDescription ?? tool.description,
			reason: decision.reason,
			changedSinceApproval: pinChanged || decision.reason === "changed",
			mode: server.approval,
			canAllowForChat: call.chatId !== null,
			claimsReadOnly: tool.claimsReadOnly
		};
		let choice: ApprovalChoice;
		try {
			choice = await this.host.confirmCall(card, signal);
		} catch (error) {
			if (!signal.aborted) {
				this.host.logger.warn(`MCP approval dialog failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			choice = "deny";
		}
		if (signal.aborted) {
			return { kind: "stopped" };
		}
		// Default-deny: only an explicit allow counts. Anything else the host returns (undefined from a dismissed dialog, null, an
		// unknown string) is not consent.
		if (choice !== "allow-once" && choice !== "allow-chat") {
			return { kind: "denied" };
		}
		this.host.deviceTrust.set(pinKey(tool.serverId, tool.toolName), tool.fingerprint);
		if (choice === "allow-chat" && call.chatId !== null) {
			const grants = this.chatGrants.get(call.chatId) ?? new Map<string, Grant>();
			grants.set(key, { fingerprint: tool.fingerprint, scope: "chat" });
			this.chatGrants.set(call.chatId, grants);
		}
		return { kind: "allowed" };
	}

	/** Forget "Allow for this chat" decisions when a conversation ends. */
	forgetChat(chatId: string): void {
		this.chatGrants.delete(chatId);
	}

	// Shutdown --------------------------------------------------------------------------------------------------------------

	/** Stops every server: stdin closed, then SIGTERM, then SIGKILL. Await this in onunload. Idempotent. */
	async shutdown(): Promise<void> {
		this.closed = true;
		const runtimes = [...this.runtimes.values()];
		this.chatGrants.clear();
		const closing = Promise.all(runtimes.map((runtime) => this.dispose(runtime).catch((error: unknown) => {
			this.host.logger.warn(`MCP server ${runtime.serverId} did not stop cleanly: ${redactMcpText(error instanceof Error ? error.message : String(error))}`);
		})));
		let timer: number | null = null;
		const deadline = new Promise<void>((resolve) => {
			timer = window.setTimeout(resolve, this.host.tuning?.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS);
		});
		await Promise.race([closing.then(() => undefined), deadline]);
		if (timer !== null) {
			window.clearTimeout(timer);
		}
		this.runtimes.clear();
		this.emit();
	}
}
