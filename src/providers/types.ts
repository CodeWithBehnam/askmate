import type {
	AskMateHttpResponse,
	ProviderSettings,
	TextProviderId
} from "../shared/core";

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
}
