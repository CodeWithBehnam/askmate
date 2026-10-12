import { DEFAULT_PROVIDER_SETTINGS, TEXT_PROVIDER_IDS, TEXT_PROVIDER_LABELS } from "../settings/constants";
import type { TextProviderId } from "../shared/types";

/**
 * Static facts about each chat provider that the setup flow needs: names for chips, where to create a key, and what
 * must be supplied by the user. Labels, default models and default addresses are read from the settings constants, so
 * there is one source of truth for them.
 */

export interface ProviderCatalogEntry {
	id: TextProviderId;
	/** Full name, as shown in settings and the provider list. */
	label: string;
	/** Short name for the provider chips in the Connect card. */
	chipLabel: string;
	needsKey: boolean;
	/** True when the address has no usable default and the user must supply it. */
	needsEndpoint: boolean;
	/** Page where the user creates a key. Null for providers that need none. */
	keyUrl: string | null;
	/** Where to get the software for a local provider. */
	helpUrl: string | null;
	defaultModel: string;
	defaultBaseUrl: string;
}

const CHIP_LABELS: Record<TextProviderId, string> = {
	openai: "OpenAI",
	"azure-openai": "Azure OpenAI",
	"azure-ai": "Azure AI",
	openrouter: "OpenRouter",
	anthropic: "Anthropic",
	"google-gemini": "Gemini",
	"openai-compatible": "Local"
};

// Each address was opened on 12/10/2026. The OpenAI dashboard answers scripted requests with 403 (bot protection), so
// that one is confirmed from OpenAI's own documentation links. The others redirect to sign-in, which is expected.
const KEY_URLS: Record<TextProviderId, string | null> = {
	openai: "https://platform.openai.com/api-keys",
	"azure-openai": "https://ai.azure.com/",
	"azure-ai": "https://ai.azure.com/",
	openrouter: "https://openrouter.ai/settings/keys",
	anthropic: "https://platform.claude.com/settings/keys",
	"google-gemini": "https://aistudio.google.com/apikey",
	"openai-compatible": null
};

const HELP_URLS: Partial<Record<TextProviderId, string>> = {
	"openai-compatible": "https://ollama.com/download"
};

const ENDPOINT_REQUIRED: ReadonlySet<TextProviderId> = new Set<TextProviderId>(["azure-openai", "azure-ai", "openai-compatible"]);

function buildEntry(id: TextProviderId): ProviderCatalogEntry {
	return {
		id,
		label: TEXT_PROVIDER_LABELS[id],
		chipLabel: CHIP_LABELS[id],
		needsKey: id !== "openai-compatible",
		needsEndpoint: ENDPOINT_REQUIRED.has(id),
		keyUrl: KEY_URLS[id],
		helpUrl: HELP_URLS[id] ?? null,
		defaultModel: DEFAULT_PROVIDER_SETTINGS[id].model,
		defaultBaseUrl: DEFAULT_PROVIDER_SETTINGS[id].baseUrl
	};
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = TEXT_PROVIDER_IDS.map(buildEntry);

/** The four providers offered as chips in the Connect card; the others stay reachable from settings. */
export const SETUP_CARD_PROVIDER_IDS: readonly TextProviderId[] = ["openai", "anthropic", "google-gemini", "openai-compatible"];

export function getProviderCatalogEntry(id: TextProviderId): ProviderCatalogEntry {
	return PROVIDER_CATALOG.find((entry) => entry.id === id) ?? buildEntry(id);
}

export function listSetupCardProviders(): ProviderCatalogEntry[] {
	return SETUP_CARD_PROVIDER_IDS.map(getProviderCatalogEntry);
}

/**
 * Obsidian secret IDs are lowercase alphanumerics with optional dashes. Picks the first free
 * `askmate-<provider>-key[-n]` so a second key for the same provider never overwrites the first.
 */
export function buildSecretId(providerId: TextProviderId, existingIds: readonly string[]): string {
	const taken = new Set(existingIds);
	const base = `askmate-${providerId}-key`;
	if (!taken.has(base)) {
		return base;
	}
	let suffix = 2;
	while (taken.has(`${base}-${suffix}`)) {
		suffix += 1;
	}
	return `${base}-${suffix}`;
}

export type ApiKeyCheck = { ok: true; key: string } | { ok: false; message: string };

/**
 * Structural checks only. Key formats change often, so no provider prefix is required; a pasted key that contains
 * spaces or line breaks is rejected because it is almost always two things pasted together.
 */
export function checkApiKeyInput(raw: string): ApiKeyCheck {
	const key = raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
	if (!key) {
		return { ok: false, message: "Paste your API key first." };
	}
	if (/\s/.test(key)) {
		return { ok: false, message: "That does not look like one key. Paste only the key, with no spaces or line breaks." };
	}
	if (key.length < 8) {
		return { ok: false, message: "That key looks too short. Copy the whole key from the provider's page." };
	}
	return { ok: true, key };
}

export interface ConnectPlan {
	providerId: TextProviderId;
	secretId: string;
	secret: string;
	/** Provider settings to apply after the secret is stored. */
	settingsPatch: { apiKeySecretName: string };
}

/**
 * Everything the Connect card needs to save a key, as plain data: the secret to store under a generated ID and the
 * provider field to update. The shell stores the secret, applies the patch and runs the test. The local provider needs
 * no key; its card only prefills `defaultBaseUrl` from the catalogue.
 */
export function planConnect(
	providerId: TextProviderId,
	rawKey: string,
	existingSecretIds: readonly string[]
): { ok: true; plan: ConnectPlan } | { ok: false; message: string } {
	const catalog = getProviderCatalogEntry(providerId);
	if (!catalog.needsKey) {
		return { ok: false, message: `${catalog.label} does not need an API key.` };
	}
	const checked = checkApiKeyInput(rawKey);
	if (!checked.ok) {
		return checked;
	}
	const secretId = buildSecretId(providerId, existingSecretIds);
	return {
		ok: true,
		plan: {
			providerId,
			secretId,
			secret: checked.key,
			settingsPatch: { apiKeySecretName: secretId }
		}
	};
}
