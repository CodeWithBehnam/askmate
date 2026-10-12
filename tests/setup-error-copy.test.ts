import { describe, expect, test } from "bun:test";
import { mapProviderErrorToSetupCopy } from "../src/setup";

function httpError(status: number, message = "failed"): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

describe("mapProviderErrorToSetupCopy", () => {
	test("401 asks for the key again", () => {
		const copy = mapProviderErrorToSetupCopy(httpError(401), { providerId: "openai" });
		expect(copy.category).toBe("auth");
		expect(copy.action).toEqual({ kind: "update-key", label: "Update key" });
		expect(copy.message).toBe("OpenAI rejected the API key. Check that you copied the whole key.");
	});

	test("403 names the model and offers another one", () => {
		const copy = mapProviderErrorToSetupCopy(httpError(403), { providerId: "anthropic", model: "claude-opus-5-5" });
		expect(copy.category).toBe("forbidden");
		expect(copy.action.kind).toBe("choose-model");
		expect(copy.message).toContain("claude-opus-5-5");
	});

	test("404 on a hosted provider names the host and offers another model", () => {
		const copy = mapProviderErrorToSetupCopy(httpError(404), { providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "x/y" });
		expect(copy.category).toBe("not-found");
		expect(copy.message).toContain("openrouter.ai");
		expect(copy.action.kind).toBe("choose-model");
	});

	test("404 on a local server says the model is not installed there", () => {
		const copy = mapProviderErrorToSetupCopy(httpError(404), { providerId: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.1" });
		expect(copy.message).toContain("localhost:11434");
		expect(copy.message).toContain("llama3.1");
		expect(copy.action.kind).toBe("choose-model");
	});

	test("429 says to wait and offers a retry", () => {
		const copy = mapProviderErrorToSetupCopy(httpError(429), { providerId: "google-gemini" });
		expect(copy.category).toBe("rate-limit");
		expect(copy.action.kind).toBe("retry");
		expect(copy.message).toContain("Google Gemini");
	});

	test("5xx and timeouts are retryable", () => {
		expect(mapProviderErrorToSetupCopy(httpError(503), { providerId: "openai" }).category).toBe("server");
		expect(mapProviderErrorToSetupCopy(httpError(504), { providerId: "openai" }).category).toBe("timeout");
		expect(mapProviderErrorToSetupCopy(httpError(500), { providerId: "openai" }).action.kind).toBe("retry");
	});

	test("a refused connection to localhost asks to start the server and test again", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("net::ERR_CONNECTION_REFUSED"), { providerId: "openai-compatible", baseUrl: "http://localhost:11434/v1" });
		expect(copy.category).toBe("local-unreachable");
		expect(copy.message).toBe("AskMate could not reach the local server at localhost:11434. Start it, then choose Test again.");
		expect(copy.action).toEqual({ kind: "start-server", label: "Test again" });
	});

	test("a slow local server is not promised a restart either: the button only tests again", () => {
		const copy = mapProviderErrorToSetupCopy(httpError(504), { providerId: "openai-compatible", baseUrl: "http://localhost:11434/v1" });
		expect(copy.category).toBe("timeout");
		expect(copy.message).toBe("The server at localhost:11434 took too long to answer. Check that it is running, then choose Test again.");
		expect(copy.action).toEqual({ kind: "start-server", label: "Test again" });
		expect(JSON.stringify(copy)).not.toMatch(/restart/i);
	});

	test("a local address is recognised even when the provider id is not the local one", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("connect ECONNREFUSED 127.0.0.1:1234"), { providerId: "openrouter", baseUrl: "http://127.0.0.1:1234/v1" });
		expect(copy.category).toBe("local-unreachable");
	});

	test("a network failure to a hosted provider names the host", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("Failed to fetch"), { providerId: "openai", baseUrl: "https://api.openai.com/v1" });
		expect(copy.category).toBe("network");
		expect(copy.message).toBe("AskMate could not reach api.openai.com. Check your internet connection, then try again.");
		expect(copy.action.kind).toBe("retry");
	});

	test("the host can come from the message when no context is given", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("getaddrinfo ENOTFOUND while calling https://api.anthropic.com/v1/messages"));
		expect(copy.message).toContain("api.anthropic.com");
	});

	test("reads the phrases the provider layer already writes", () => {
		const auth = mapProviderErrorToSetupCopy(new Error("OpenAI authentication failed. Check the API key secret in AskMate settings."), { providerId: "openai" });
		expect(auth.category).toBe("auth");
		const quota = mapProviderErrorToSetupCopy(new Error("OpenAI rate limit or quota was reached. Wait, reduce context, or check billing."), { providerId: "openai" });
		expect(quota.category).toBe("rate-limit");
		const missing = mapProviderErrorToSetupCopy(new Error("OpenAI could not find the endpoint or model. Check the base URL and model ID."), { providerId: "openai" });
		expect(missing.category).toBe("not-found");
		const status = mapProviderErrorToSetupCopy(new Error("Mistral request failed with HTTP 401. Provider message: nope"), { providerId: "azure-ai" });
		expect(status.category).toBe("auth");
	});

	test("an address the validator rejected asks for the address", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("Azure OpenAI base URL must start with http:// or https://."), { providerId: "azure-openai" });
		expect(copy.category).toBe("invalid-address");
		expect(copy.action.kind).toBe("check-address");
	});

	test("anything else gets a calm generic sentence and keeps the original as detail", () => {
		const copy = mapProviderErrorToSetupCopy(new Error("weird   failure\nwith lines"), { providerId: "openai" });
		expect(copy.category).toBe("unknown");
		expect(copy.message).toContain("OpenAI");
		expect(copy.detail).toBe("weird failure with lines");
		expect(mapProviderErrorToSetupCopy("text only").detail).toBe("text only");
		expect(mapProviderErrorToSetupCopy(undefined).category).toBe("unknown");
	});

	test("never puts a raw status code in the message", () => {
		for (const status of [401, 403, 404, 429, 500, 504]) {
			expect(mapProviderErrorToSetupCopy(httpError(status), { providerId: "openai" }).message).not.toMatch(/\b\d{3}\b/);
		}
	});

	test("long details are shortened", () => {
		expect(mapProviderErrorToSetupCopy(new Error("x".repeat(500))).detail.length).toBeLessThanOrEqual(203);
	});
});
