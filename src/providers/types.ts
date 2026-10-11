import type {
	AskMateHttpResponse,
	ProviderSettings,
	TextProviderId
} from "../shared/core";
import type { SseEvent } from "./sse";
import type { SseRequestInit, SseTransportOutcome } from "./sseTransport";

export interface ProviderRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	abortSignal?: AbortSignal;
	timeoutMs?: number;
	timeoutMessage?: string;
}

export interface ProviderRuntime {
	getProviderSettings(providerId: TextProviderId): ProviderSettings;
	getProviderApiKey(providerId: TextProviderId): Promise<string>;
	requestJson<T>(url: string, options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>>;
	/**
	 * Streams a Server-Sent Events response, cancelling the HTTP request on abort. Absent when streaming is
	 * switched off or unsupported, in which case providers use requestJson.
	 */
	streamSse?(url: string, options: SseRequestInit, onEvent: (event: SseEvent) => void): Promise<SseTransportOutcome>;
}
