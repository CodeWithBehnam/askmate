import { DEFAULT_PROVIDER_SETTINGS, TEXT_PROVIDER_IDS, TEXT_PROVIDER_LABELS } from "../../settings/constants";
import type { AskMateSettings, TextProviderId } from "../../shared/types";

/**
 * Pure rules for the sidebar model and provider switcher: matching what the user typed against known IDs, listing
 * the choices, and applying a choice to the settings. The view only wires these to Obsidian.
 */

export type MatchResult<T> =
	| { kind: "exact" | "match"; value: T }
	| { kind: "ambiguous"; candidates: T[] }
	| { kind: "none" };

export interface ModelChoice {
	providerId: TextProviderId;
	providerName: string;
	model: string;
}

export interface ParsedModelQuery {
	query: string;
	/** True when the query ended in "!", meaning "use this ID even though it is not listed". */
	force: boolean;
}

export type ModelResolution =
	| { kind: "use"; model: string; listed: boolean }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "unknown"; query: string };

/** Distinct, non-empty IDs in first-seen order. */
function uniqueIds(ids: readonly string[]): string[] {
	return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

/**
 * Exact match first (case-sensitive, then case-insensitive), then a unique prefix, then a unique substring.
 * A prefix or substring shared by several IDs is reported as ambiguous so the caller can list them.
 */
export function matchIdentifier(query: string, candidates: readonly string[], labels?: (candidate: string) => string): MatchResult<string> {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return { kind: "none" };
	}
	const exactCase = candidates.find((candidate) => candidate === query.trim());
	if (exactCase !== undefined) {
		return { kind: "exact", value: exactCase };
	}
	const keys = (candidate: string): string[] => [candidate.toLowerCase(), ...(labels ? [labels(candidate).toLowerCase()] : [])];
	const exact = candidates.filter((candidate) => keys(candidate).includes(needle));
	if (exact.length === 1) {
		return { kind: "exact", value: exact[0] };
	}
	for (const test of [(key: string) => key.startsWith(needle), (key: string) => key.includes(needle)]) {
		const found = candidates.filter((candidate) => keys(candidate).some(test));
		if (found.length === 1) {
			return { kind: "match", value: found[0] };
		}
		if (found.length > 1) {
			return { kind: "ambiguous", candidates: found };
		}
	}
	return { kind: "none" };
}

export function parseModelQuery(argument: string): ParsedModelQuery {
	const trimmed = argument.trim();
	const force = trimmed.length > 1 && trimmed.endsWith("!");
	return { query: force ? trimmed.slice(0, -1).trim() : trimmed, force };
}

/**
 * Decides which model ID to switch to. Unlisted IDs are accepted only with the "!" suffix, because many providers
 * serve IDs that are not in the refreshed list but a typo should not silently become the model.
 */
export function resolveModelQuery(argument: string, available: readonly string[]): ModelResolution {
	const { query, force } = parseModelQuery(argument);
	const match = matchIdentifier(query, available);
	if (match.kind === "exact" || match.kind === "match") {
		return { kind: "use", model: match.value, listed: true };
	}
	if (match.kind === "ambiguous" && !force) {
		return { kind: "ambiguous", candidates: match.candidates };
	}
	if (force && query) {
		return { kind: "use", model: query, listed: false };
	}
	return { kind: "unknown", query };
}

export function resolveProviderQuery(query: string): MatchResult<TextProviderId> {
	const result = matchIdentifier(query, TEXT_PROVIDER_IDS, (id) => TEXT_PROVIDER_LABELS[id as TextProviderId]);
	if (result.kind === "ambiguous") {
		return { kind: "ambiguous", candidates: result.candidates.map((id) => id as TextProviderId) };
	}
	if (result.kind === "none") {
		return result;
	}
	return { kind: result.kind, value: result.value as TextProviderId };
}

type ProviderModelSource = Pick<AskMateSettings["providers"][TextProviderId], "model" | "modelOptions">;

/** The selected model first, then the refreshed list, then the built-in defaults. */
export function listProviderModels(providerId: TextProviderId, settings: Pick<AskMateSettings, "providers">): string[] {
	const saved: ProviderModelSource | undefined = settings.providers?.[providerId];
	return uniqueIds([
		saved?.model ?? "",
		...(saved?.modelOptions ?? []),
		DEFAULT_PROVIDER_SETTINGS[providerId].model,
		...DEFAULT_PROVIDER_SETTINGS[providerId].modelOptions
	]);
}

/** Local servers often need no key; every other provider cannot answer without one. */
export function providerNeedsApiKey(providerId: TextProviderId, settings: Pick<AskMateSettings, "providers">): boolean {
	if (providerId === "openai-compatible") {
		return false;
	}
	return (settings.providers?.[providerId]?.apiKeySecretName ?? "").trim().length === 0;
}

/** Provider and model pairs for the picker. Providers without a key are left out unless they are the current one. */
export function buildModelChoices(settings: Pick<AskMateSettings, "providers">, currentProviderId: TextProviderId): ModelChoice[] {
	return TEXT_PROVIDER_IDS
		.filter((providerId) => providerId === currentProviderId || !providerNeedsApiKey(providerId, settings))
		.flatMap((providerId) => listProviderModels(providerId, settings).map((model) => ({
			providerId,
			providerName: TEXT_PROVIDER_LABELS[providerId],
			model
		})));
}

/** Mutates the settings in place; the caller saves them, which also re-mirrors the OpenAI model fields. */
export function applyChatSelection(settings: AskMateSettings, providerId: TextProviderId, model?: string): void {
	settings.providerRoles.chatProviderId = providerId;
	settings.selectedTextProvider = providerId;
	if (model !== undefined) {
		settings.providers[providerId].model = model;
		const options = settings.providers[providerId].modelOptions;
		if (!options.includes(model)) {
			options.push(model);
		}
	}
}

export function formatModelListing(
	providerName: string,
	current: string,
	models: readonly string[]
): string {
	const lines = models.map((model) => `  ${model === current ? "*" : " "} ${model}`);
	return [
		`Provider: ${providerName}`,
		`Model: ${current || "(none selected)"}`,
		...(lines.length > 0 ? ["", "Available models (* is current)", ...lines] : []),
		"",
		"Switch with /model <id> (a unique start or part of the name works).",
		"Use /model <id>! for an ID that is not listed. /provider switches provider."
	].join("\n");
}

export function formatProviderListing(currentId: TextProviderId, settings: Pick<AskMateSettings, "providers">): string {
	const lines = TEXT_PROVIDER_IDS.map((id) => {
		const marker = id === currentId ? "*" : " ";
		const note = providerNeedsApiKey(id, settings) ? " (no API key set)" : "";
		return `  ${marker} ${id.padEnd(18)}${TEXT_PROVIDER_LABELS[id]}${note}`;
	});
	return ["Providers (* is current)", ...lines, "", "Switch with /provider <id>."].join("\n");
}
