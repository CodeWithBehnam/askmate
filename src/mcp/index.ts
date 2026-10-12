/**
 * Public surface of the MCP client. launch.ts is deliberately not re-exported: it is the only module that imports child_process,
 * and only the desktop wiring in the plugin imports it directly.
 */
export { McpService, forgetServerTrust, type TrustOutcome } from "./McpService";
export { McpClient, DEFAULT_CLIENT_CONFIG, type McpClientConfig, type EraHint, type ServerSession, type ToolCatalogue } from "./McpClient";
export {
	DEFAULT_MCP_SETTINGS,
	MAX_SERVERS,
	MCP_SECRET_PREFIX,
	type McpHttpServerConfig,
	type McpServerConfig,
	type McpSettings,
	type McpStdioServerConfig,
	type McpValue,
	findSecretRisks,
	isValidHeaderName,
	isValidSecretId,
	isValidServerId,
	normalizeMcpSettings,
	secretIdFor,
	slugifyServerId,
	trustHash,
	validateServerConfig
} from "./config";
export type {
	ApprovalChoice,
	DeviceTrustStore,
	McpClock,
	McpHost,
	McpLogger,
	McpPlatform,
	McpTuning,
	McpSecrets,
	McpServerState,
	McpServerStatus,
	SnapshotServer,
	SnapshotTool,
	ToolApprovalCard,
	ToolCallRequest,
	ToolFailureKind,
	ToolOutcome,
	ToolOutcomeStatus,
	ToolSnapshot,
	TrustRequest
} from "./host";
export { describeMcpError, type McpErrorCopy } from "./errors";
export { parseMcpImport, type ImportResult, type ImportSkip, type ImportedSecret, type ImportedServer } from "./importConfig";
export { HttpTransport, validateServerUrl, type HttpRequest, type HttpRequestFn, type HttpResponse } from "./httpTransport";
export { McpClientError, type McpErrorKind, type McpTool, type McpToolResult } from "./protocol";
export { redactMcpText } from "./redact";
export type { LaunchRequest } from "./spawnPlan";
export type { ChildLike } from "./stdioTransport";
export {
	APPROVAL_MODES,
	type ApprovalDecision,
	type ApprovalMode,
	type Grant,
	buildModelToolNames,
	decideApproval,
	findDescriptionWarnings,
	fingerprintTool,
	isApprovalMode,
	renderToolResult,
	sanitiseDescription
} from "./toolPolicy";
