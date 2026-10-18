import { isLocalNetworkHost } from "../settings/normalize";
import type { TextProviderId } from "../shared/types";
import { getProviderCatalogEntry } from "./providerCatalog";

/**
 * Plain-language copy for provider and transport failures. Each failure maps to one sentence that names the host and
 * one action the interface can offer as a button, so the user is never left with a raw status code.
 */

export type SetupActionKind = "update-key" | "choose-model" | "check-address" | "start-server" | "retry" | "test" | "open-settings";

export interface SetupAction {
	kind: SetupActionKind;
	/** Button text, sentence case. */
	label: string;
}

export type SetupErrorCategory =
	| "auth"
	| "forbidden"
	| "not-found"
	| "rate-limit"
	| "timeout"
	| "server"
	| "network"
	| "local-unreachable"
	| "invalid-address"
	| "unknown";

export interface SetupErrorCopy {
	category: SetupErrorCategory;
	message: string;
	action: SetupAction;
	/** The original text, shortened, for a details disclosure. Provider errors are redacted before they reach here. */
	detail: string;
}

export interface ErrorCopyContext {
	providerId?: TextProviderId;
	baseUrl?: string;
	model?: string;
}

export const SETUP_ACTIONS: Readonly<Record<SetupActionKind, SetupAction>> = {
	"update-key": { kind: "update-key", label: "Update key" },
	"choose-model": { kind: "choose-model", label: "Choose another model" },
	"check-address": { kind: "check-address", label: "Check the address" },
	"start-server": { kind: "start-server", label: "Test again" },
	retry: { kind: "retry", label: "Try again" },
	test: { kind: "test", label: "Test connection" },
	"open-settings": { kind: "open-settings", label: "Open settings" }
};

const MAX_DETAIL_LENGTH = 200;

function errorText(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (error && typeof error === "object") {
		const message: unknown = Reflect.get(error, "message");
		return typeof message === "string" ? message : "";
	}
	return "";
}

function readStatus(error: unknown): number | null {
	if (!error || typeof error !== "object") {
		return null;
	}
	for (const key of ["status", "statusCode"]) {
		const value: unknown = Reflect.get(error, key);
		if (typeof value === "number" && value >= 100 && value <= 599) {
			return value;
		}
	}
	const response: unknown = Reflect.get(error, "response");
	return response && typeof response === "object" ? readStatus(response) : null;
}

function statusFromText(text: string): number | null {
	const match = /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(text);
	return match ? Number(match[1]) : null;
}

function categoryFromStatus(status: number): SetupErrorCategory | null {
	if (status === 401) {
		return "auth";
	}
	if (status === 403) {
		return "forbidden";
	}
	if (status === 404) {
		return "not-found";
	}
	if (status === 408 || status === 504) {
		return "timeout";
	}
	if (status === 429) {
		return "rate-limit";
	}
	return status >= 500 ? "server" : null;
}

const TEXT_PATTERNS: ReadonlyArray<[RegExp, SetupErrorCategory]> = [
	[/base url must|base url is not a valid|must start with http|not a valid url|invalid url/i, "invalid-address"],
	[/ERR_CONNECTION_REFUSED|ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION|EAI_AGAIN|ECONNRESET|failed to fetch|fetch failed|network ?error|getaddrinfo|net::ERR|socket hang up/i, "network"],
	[/authentication failed|invalid api key|incorrect api key|unauthori[sz]ed|invalid x-api-key|api key not valid/i, "auth"],
	[/access is forbidden|\bforbidden\b|permission denied|not allowed to use/i, "forbidden"],
	[/could not find the endpoint or model|(?:model|deployment|endpoint).{0,80}(?:does not exist|not found)|no such model|not found.{0,40}(?:model|deployment|endpoint)/i, "not-found"],
	[/rate limit|quota|too many requests/i, "rate-limit"],
	[/timed out|timeout/i, "timeout"],
	[/service error|overloaded|bad gateway|service unavailable|internal server error/i, "server"]
];

function categorise(error: unknown, text: string): SetupErrorCategory {
	const status = readStatus(error) ?? statusFromText(text);
	const fromStatus = status === null ? null : categoryFromStatus(status);
	if (fromStatus) {
		return fromStatus;
	}
	return TEXT_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? "unknown";
}

/** Host and port of the provider address, taken from the context or, failing that, from the message. */
function hostFor(context: ErrorCopyContext, text: string): string | null {
	const candidates = [context.baseUrl ?? "", /https?:\/\/[^\s"')]+/i.exec(text)?.[0] ?? ""];
	for (const candidate of candidates) {
		try {
			const url = new URL(candidate.trim());
			if (url.host) {
				return url.host;
			}
		} catch {
			// Not an address; try the next candidate.
		}
	}
	return null;
}

function isLocalHost(host: string | null, providerId: TextProviderId | undefined): boolean {
	if (providerId === "openai-compatible") {
		return true;
	}
	if (!host) {
		return false;
	}
	return isLocalNetworkHost(host.replace(/:\d+$/, ""));
}

function shorten(text: string): string {
	const plain = text.replace(/\s+/g, " ").trim();
	return plain.length > MAX_DETAIL_LENGTH ? `${plain.slice(0, MAX_DETAIL_LENGTH)}...` : plain;
}

/**
 * Turns whatever a provider call threw into one sentence and one button. Reads a numeric `status` when the error
 * carries one, then "HTTP nnn" in the text, then the phrases the provider layer already uses.
 */
export function mapProviderErrorToSetupCopy(error: unknown, context: ErrorCopyContext = {}): SetupErrorCopy {
	const text = errorText(error);
	const category = categorise(error, text);
	const host = hostFor(context, text);
	const local = isLocalHost(host, context.providerId);
	const name = context.providerId ? getProviderCatalogEntry(context.providerId).label : "The provider";
	const where = host ?? name;
	const model = context.model?.trim() ?? "";
	const build = (resolved: SetupErrorCategory, message: string, action: SetupAction): SetupErrorCopy => ({
		category: resolved,
		message,
		action,
		detail: shorten(text)
	});

	switch (category) {
		case "auth":
			return build(category, `${name} rejected the API key. Check that you copied the whole key.`, SETUP_ACTIONS["update-key"]);
		case "forbidden":
			return build(
				category,
				`${name} says this key cannot use ${model ? `the model ${model}` : "that model"}. Check your account access, or choose another model.`,
				SETUP_ACTIONS["choose-model"]
			);
		case "not-found":
			return local
				? build(category, `The server at ${where} does not have ${model ? `the model ${model}` : "that model"}. Install it there, or choose another model.`, SETUP_ACTIONS["choose-model"])
				: build(category, `${where} could not find ${model ? `the model ${model}` : "that model"}. Choose another model, or check the address.`, SETUP_ACTIONS["choose-model"]);
		case "rate-limit":
			return build(category, `${name} is limiting requests or your quota is used up. Wait a moment, or check your plan and billing.`, SETUP_ACTIONS.retry);
		case "timeout":
			return local
				? build(category, `The server at ${where} took too long to answer. Check that it is running, then choose Test again.`, SETUP_ACTIONS["start-server"])
				: build(category, `${name} took too long to answer. Try again, or send less context.`, SETUP_ACTIONS.retry);
		case "server":
			return build(category, `${name} is having trouble right now. Try again in a minute.`, SETUP_ACTIONS.retry);
		case "invalid-address":
			return build(category, `The address for ${name} is not valid. Check the spelling and the port, for example http://localhost:11434/v1. It must start with https://, or http:// for a server on this computer or network.`, SETUP_ACTIONS["check-address"]);
		case "network":
			return local
				? build("local-unreachable", `AskMate could not reach the local server at ${where}. Start it, then choose Test again.`, SETUP_ACTIONS["start-server"])
				: build(category, `AskMate could not reach ${where}. Check your internet connection, then try again.`, SETUP_ACTIONS.retry);
		case "local-unreachable":
		case "unknown":
			return build("unknown", `Something went wrong while talking to ${name}. Try again, or open settings to check the connection.`, SETUP_ACTIONS.retry);
	}
}
