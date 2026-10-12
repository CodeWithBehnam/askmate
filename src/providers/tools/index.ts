/**
 * Tool calling for AskMate providers. The neutral model (ToolSpec, ToolCall, ToolResult, HistoryItem), four pure wire
 * adapters, a bounded loop and a one-turn transport. Nothing in the text-only provider paths imports this directory.
 */
export {
	getToolWireAdapter,
	supportsTools,
	CHAT_QUIRKS,
	type ToolBodyOptions,
	type ToolWireAdapter,
	type ToolWireFamily
} from "./adapter";
export {
	DEFAULT_TOOL_LOOP_LIMITS,
	describeToolLoopEnd,
	runToolLoop,
	truncateResult,
	type ToolLoopDeps,
	type ToolLoopEnd,
	type ToolLoopLimits,
	type ToolLoopProgress,
	type ToolLoopResult,
	type ToolRuntime
} from "./loop";
export { buildToolNameMap, findWireName, WIRE_NAME_MAX, type ToolRef } from "./names";
export {
	addUsage,
	ProviderToolError,
	type HistoryItem,
	type Json,
	type JsonObject,
	type ProviderId,
	type StopKind,
	type ToolCall,
	type ToolChoice,
	type ToolResult,
	type ToolSpec,
	type TurnRequest,
	type TurnResult,
	type Usage
} from "./neutral";
export { normaliseToolSchema, prepareGeminiJsonSchema, toGeminiOpenApiSchema } from "./schema";
export {
	createToolTurnMemory,
	createToolTurnSender,
	getToolTurnEndpoint,
	getToolTurnMaxOutputTokens,
	getToolTurnReasoningEffort,
	sendToolTurn,
	ToolsUnsupportedError,
	type ToolTurnContext,
	type ToolTurnMemory
} from "./turn";
