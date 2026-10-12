import type { McpClientConfig } from "./McpClient";
import type { McpServerConfig, McpSettings } from "./config";
import type { HttpRequestFn } from "./httpTransport";
import type { ClientIdentity, Era, JsonObject, McpErrorKind } from "./protocol";
import type { LaunchRequest } from "./spawnPlan";
import type { ChildLike } from "./stdioTransport";
import type { ApprovalMode } from "./toolPolicy";

/**
 * Everything McpService needs from the outside world. The plugin builds one real host (requestUrl, SecretStorage, app local storage,
 * child_process behind launch.ts, Obsidian modals) and tests build a fake one. Nothing below imports Obsidian or Node.
 */

export interface McpPlatform {
	/** Platform.isDesktopApp. Local (stdio) servers are refused unless this is true. */
	readonly isDesktopApp: boolean;
	readonly os: NodeJS.Platform;
	/** The Obsidian process environment. Only an allow-list of it is passed to a server. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Reads from Obsidian SecretStorage. Returns null for an unset secret. Called at send or spawn time, never cached by the service. */
export interface McpSecrets {
	get(id: string): string | null;
}

/**
 * Device-local key-value store (app.saveLocalStorage in the plugin). Trust is kept here and not in data.json on purpose:
 * data.json can sync from another computer, and a synced definition must not arrive already trusted.
 */
export interface DeviceTrustStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

export interface McpLogger {
	warn(message: string): void;
	error(message: string): void;
}

export interface McpClock {
	now(): number;
}

export type TrustRequest =
	| {
		readonly transport: "stdio";
		readonly serverId: string;
		readonly label: string;
		/** First trust, or the definition changed since it was trusted. */
		readonly reason: "first-use" | "changed";
		/** The exact command and arguments, quoted for reading. Display only: AskMate never runs a shell. */
		readonly commandLine: string;
		readonly command: string;
		readonly args: readonly string[];
		/**
		 * Plain values are shown; secret values are shown as "stored secret" together with the SecretStorage id they come from, so
		 * the person can see which stored secret goes to which variable. `secretId` is null for a plain value.
		 */
		readonly env: ReadonlyArray<{ readonly name: string; readonly value: string; readonly secret: boolean; readonly secretId: string | null }>;
		/** Advisory warnings from findCommandRisks and findSecretRisks (a secret that was not stored for this server). */
		readonly risks: readonly string[];
	}
	| {
		readonly transport: "http";
		readonly serverId: string;
		readonly label: string;
		readonly reason: "first-use" | "changed";
		readonly url: string;
		readonly host: string;
		readonly headerNames: readonly string[];
		readonly hasBearerToken: boolean;
		/** SecretStorage id of the bearer token that will be sent to `host`, or null when there is none. */
		readonly bearerSecretId: string | null;
		/** Headers whose value comes from SecretStorage, with the id each is read from. A subset of `headerNames`. */
		readonly secretHeaders: ReadonlyArray<{ readonly name: string; readonly secretId: string }>;
		/** Advisory warnings from findSecretRisks (a secret that was not stored for this server). */
		readonly risks: readonly string[];
	};

export type ApprovalChoice = "allow-once" | "allow-chat" | "deny";

/** Everything the approval dialog or inline card shows. Arguments are never truncated. */
export interface ToolApprovalCard {
	readonly serverId: string;
	readonly serverLabel: string;
	readonly toolName: string;
	readonly toolTitle: string;
	/** Pretty-printed JSON of exactly what will be sent. */
	readonly argumentsText: string;
	readonly warnings: readonly string[];
	/** The server's own description, with invisible characters made visible. Not what the model is shown. */
	readonly description: string;
	readonly reason: "first-use" | "changed" | "mode" | "possible-side-effect";
	/** The tool definition differs from the one approved on this device before. */
	readonly changedSinceApproval: boolean;
	readonly mode: ApprovalMode;
	/** False when there is no conversation to scope a grant to. Hide "Allow for this chat" then. */
	readonly canAllowForChat: boolean;
	/** The server's readOnlyHint, shown as an unverified claim. */
	readonly claimsReadOnly: boolean;
}

export interface McpHost {
	readonly platform: McpPlatform;
	readonly identity: ClientIdentity;
	/** Read on every use, so edits in settings take effect without recreating the service. */
	settings(): McpSettings;
	readonly secrets: McpSecrets;
	readonly deviceTrust: DeviceTrustStore;
	/** Plugin: wraps requestUrl with throw false and lower-cased header names. */
	readonly requestHttp: HttpRequestFn;
	/** Plugin: spawnChild from launch.ts. Only called on desktop. Errors surface through the child's "error" event. */
	readonly launchProcess: (request: LaunchRequest) => ChildLike;
	/** Plugin: resolveLoginPath from launch.ts. The service calls it at most once. */
	readonly resolveLoginPath: () => Promise<string | null>;
	/** Shows the "Trust and start" dialog. Resolves true only on an explicit yes; the service treats any other value as a refusal. */
	confirmTrust(request: TrustRequest): Promise<boolean>;
	/**
	 * Shows the per-call approval card. Must resolve "deny" (or reject) if the signal aborts. The service allows a call only for
	 * "allow-once" or "allow-chat"; any other value, such as undefined from a dismissed dialog, counts as "deny".
	 */
	confirmCall(card: ToolApprovalCard, signal: AbortSignal): Promise<ApprovalChoice>;
	readonly clock: McpClock;
	readonly logger: McpLogger;
	/** Timing overrides. The plugin leaves this unset; tests shorten the waits. */
	readonly tuning?: McpTuning;
}

export interface McpTuning {
	readonly client?: Partial<Omit<McpClientConfig, "identity" | "now">>;
	/** How long after a failure prepareRun leaves a server alone. */
	readonly failedRetryMs?: number;
	/** How long shutdown waits before letting go of a server that will not stop. */
	readonly shutdownDeadlineMs?: number;
	/** How long a stdio server gets between each step of closing (stdin, SIGTERM, SIGKILL). */
	readonly stdioGraceMs?: number;
}

export type McpServerState =
	| { readonly kind: "off" }
	| { readonly kind: "needs-trust" }
	/** Trusted and enabled, but not started yet. Servers start on first use, never at load. */
	| { readonly kind: "idle" }
	| { readonly kind: "connecting" }
	| { readonly kind: "ready"; readonly tools: number; readonly hidden: number; readonly era: Era; readonly version: string; readonly serverName: string }
	| { readonly kind: "needs-auth"; readonly hint: string }
	| { readonly kind: "error"; readonly error: McpErrorKind; readonly message: string; readonly fix: string | null };

export interface McpServerStatus {
	readonly id: string;
	readonly label: string;
	readonly transport: McpServerConfig["transport"];
	readonly state: McpServerState;
}

export interface SnapshotTool {
	/** Provider-safe, unique name the model calls. The only way a model-chosen name reaches a server. */
	readonly modelName: string;
	readonly serverId: string;
	readonly serverLabel: string;
	readonly toolName: string;
	readonly title: string;
	/** Sanitised for the model: invisible characters removed, capped. */
	readonly description: string;
	/** Input schema with invisible characters removed from every string. */
	readonly inputSchema: JsonObject;
	/** SHA-256 over the tool definition as the server sent it. */
	readonly fingerprint: string;
	readonly warnings: readonly string[];
	/** "new": never approved on this device. "approved": the approved definition is unchanged. "changed": it differs from the approved one. */
	readonly pin: "new" | "approved" | "changed";
	readonly claimsReadOnly: boolean;
}

export interface SnapshotServer {
	readonly id: string;
	readonly label: string;
	readonly serverName: string;
	/** The server's own instructions, sanitised and capped. Untrusted text: show it, do not obey it. */
	readonly instructions: string | null;
	readonly tools: number;
	/** Hidden by the user, malformed, duplicate or oversized. */
	readonly hidden: number;
}

/**
 * The tools one run may use, fixed when the run starts. A server changing its tool list mid-run, or a second run refreshing a
 * catalogue, cannot alter it.
 */
export interface ToolSnapshot {
	readonly id: number;
	readonly createdAt: number;
	readonly tools: readonly SnapshotTool[];
	readonly byModelName: ReadonlyMap<string, SnapshotTool>;
	readonly servers: readonly SnapshotServer[];
	/** Enabled servers that cannot be used right now, with why. */
	readonly unavailable: readonly McpServerStatus[];
	/** Tools left out because the provider limit on tool count would be exceeded. */
	readonly omitted: number;
}

export interface ToolCallRequest {
	readonly snapshot: ToolSnapshot;
	/** The provider's call id. Echoed back so the loop can answer every call exactly once. */
	readonly callId: string;
	readonly modelName: string;
	/** Parsed arguments as the model produced them. Checked to be a JSON object here. */
	readonly args: unknown;
	/** Conversation the approval grant is scoped to, or null when there is none. */
	readonly chatId: string | null;
}

export type ToolOutcomeStatus = "ok" | "tool_error" | "denied" | "failed" | "aborted";
export type ToolFailureKind = McpErrorKind | "unavailable" | "changed" | "invalid_arguments" | "unknown_tool";

/** What happened to one tool call. `text` is always set: it is the tool_result block for the model. */
export interface ToolOutcome {
	readonly status: ToolOutcomeStatus;
	readonly text: string;
	readonly serverLabel: string;
	readonly toolName: string;
	readonly toolTitle: string;
	/** One redacted line for the card when the call failed. */
	readonly message: string | null;
	readonly fix: string | null;
	readonly failure: ToolFailureKind | null;
}
