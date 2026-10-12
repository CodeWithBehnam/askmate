import { DEFAULT_PROVIDER_SETTINGS } from "../settings/constants";
import { normalizeProviderRoleSettings, validateAzureOpenAIBaseUrl } from "../settings/normalize";
import type { AskMateSettings, ProviderSettings, TextProviderId } from "../shared/types";
import { SETUP_ACTIONS, type SetupAction, type SetupErrorCopy } from "./errorCopy";
import { getProviderCatalogEntry } from "./providerCatalog";

/**
 * One pure answer to "is AskMate set up?". The Connect card, the status bar, the settings page, the provider list and
 * the model picker all read it, so they cannot disagree. Whether a secret has a value is a question for the shell, so
 * it arrives as a predicate.
 */

/** Tells whether the secret store holds a value for this secret name on this device. */
export type SecretPredicate = (secretName: string) => boolean;

/**
 * Default for callers that cannot reach the secret store yet: a saved name is assumed to have a value. The old
 * name-only behaviour, kept so existing call sites compile until they pass the real predicate.
 */
export const ASSUME_SECRET_PRESENT: SecretPredicate = () => true;

export type SetupTestState =
	| { status: "idle" }
	| { status: "testing"; providerId: TextProviderId; model: string }
	| { status: "ok"; providerId: TextProviderId; model: string }
	| { status: "failed"; providerId: TextProviderId; model: string; copy: SetupErrorCopy };

export const IDLE_SETUP_TEST: SetupTestState = { status: "idle" };

export type SetupIssueKind = "needs-key" | "key-missing" | "needs-endpoint" | "needs-model";

export interface SetupIssue {
	kind: SetupIssueKind;
	message: string;
}

interface StageBase {
	providerId: TextProviderId;
	label: string;
	model: string;
}

export type SetupStage =
	/** Something must be filled in before a request can be sent. `issues` lists every gap in a stable order. */
	| (StageBase & { kind: SetupIssueKind; issues: SetupIssue[] })
	/** Complete, but the connection has not been tested for this provider and model. */
	| (StageBase & { kind: "untested" })
	| (StageBase & { kind: "testing" })
	| (StageBase & { kind: "test-failed"; copy: SetupErrorCopy })
	| (StageBase & { kind: "ready" });

type SetupSettings = Pick<AskMateSettings, "providers">;

const MISSING_ENDPOINT_MESSAGES: Partial<Record<TextProviderId, string>> = {
	"azure-openai": "Set the Azure OpenAI base URL.",
	"azure-ai": "Set the Azure AI Foundry endpoint.",
	"openai-compatible": "Set the local or self-hosted base URL."
};

function readProvider(providerId: TextProviderId, settings: SetupSettings): ProviderSettings {
	return settings.providers?.[providerId] ?? DEFAULT_PROVIDER_SETTINGS[providerId];
}

/** The model a request would use. Azure OpenAI has no default because the name is the user's own deployment. */
export function resolveSetupModel(providerId: TextProviderId, provider: ProviderSettings): string {
	return (provider.model ?? "").trim() || (providerId === "azure-openai" ? "" : DEFAULT_PROVIDER_SETTINGS[providerId].model);
}

function endpointIssue(providerId: TextProviderId, baseUrl: string): string | null {
	const missing = MISSING_ENDPOINT_MESSAGES[providerId];
	if (!missing) {
		return null;
	}
	if (!baseUrl.trim()) {
		return missing;
	}
	if (providerId === "azure-openai") {
		// The provider throws for an address its validator rejects, so setup is not complete until the validator accepts it.
		try {
			validateAzureOpenAIBaseUrl(baseUrl, "");
		} catch (error) {
			return error instanceof Error ? error.message : missing;
		}
	}
	return null;
}

/** Every gap that stops a request, in the order the settings page shows them. Empty when the provider is complete. */
export function listSetupIssues(
	providerId: TextProviderId,
	settings: SetupSettings,
	hasSecret: SecretPredicate = ASSUME_SECRET_PRESENT
): SetupIssue[] {
	const catalog = getProviderCatalogEntry(providerId);
	const provider = readProvider(providerId, settings);
	const secretName = (provider.apiKeySecretName ?? "").trim();
	const endpoint = endpointIssue(providerId, provider.baseUrl ?? "");
	const issues: Array<SetupIssue | null> = [
		catalog.needsKey && !secretName ? { kind: "needs-key", message: `Add an API key for ${catalog.label}.` } : null,
		catalog.needsKey && secretName && !hasSecret(secretName)
			? { kind: "key-missing", message: `The API key for ${catalog.label} is not stored on this device. Add it again.` }
			: null,
		endpoint ? { kind: "needs-endpoint", message: endpoint } : null,
		providerId === "azure-openai" && !resolveSetupModel(providerId, provider)
			? { kind: "needs-model", message: "Enter your Azure OpenAI deployment name." }
			: null
	];
	return issues.filter((issue): issue is SetupIssue => issue !== null);
}

/** The test result counts only when it was run for the provider and model that are selected now. */
function currentTest(lastTest: SetupTestState, providerId: TextProviderId, model: string): SetupTestState {
	return lastTest.status !== "idle" && lastTest.providerId === providerId && lastTest.model === model ? lastTest : IDLE_SETUP_TEST;
}

export function deriveProviderSetupState(
	providerId: TextProviderId,
	settings: SetupSettings,
	hasSecret: SecretPredicate = ASSUME_SECRET_PRESENT,
	lastTest: SetupTestState = IDLE_SETUP_TEST
): SetupStage {
	const catalog = getProviderCatalogEntry(providerId);
	const model = resolveSetupModel(providerId, readProvider(providerId, settings));
	const base: StageBase = { providerId, label: catalog.label, model };
	const issues = listSetupIssues(providerId, settings, hasSecret);
	if (issues.length > 0) {
		return { ...base, kind: issues[0].kind, issues };
	}
	const test = currentTest(lastTest, providerId, model);
	switch (test.status) {
		case "testing":
			return { ...base, kind: "testing" };
		case "failed":
			return { ...base, kind: "test-failed", copy: test.copy };
		case "ok":
			return { ...base, kind: "ready" };
		case "idle":
			return { ...base, kind: "untested" };
	}
}

/** Setup state of the provider that answers chat requests. */
export function deriveSetupState(
	settings: Pick<AskMateSettings, "providers" | "providerRoles" | "selectedTextProvider">,
	hasSecret: SecretPredicate = ASSUME_SECRET_PRESENT,
	lastTest: SetupTestState = IDLE_SETUP_TEST
): SetupStage {
	const { chatProviderId } = normalizeProviderRoleSettings(settings.providerRoles, settings.selectedTextProvider);
	return deriveProviderSetupState(chatProviderId, settings, hasSecret, lastTest);
}

/**
 * True once every required field is filled in. A failed test does not block sending: the send then reports the same
 * failure with its own button, and a provider outage should not lock the composer.
 */
export function isReadyToSend(stage: SetupStage): boolean {
	return stage.kind === "untested" || stage.kind === "testing" || stage.kind === "test-failed" || stage.kind === "ready";
}

/** Why the provider has no usable key on this device, or null when it has one or needs none. */
export function providerKeyIssue(
	providerId: TextProviderId,
	settings: SetupSettings,
	hasSecret: SecretPredicate = ASSUME_SECRET_PRESENT
): "needs-key" | "key-missing" | null {
	if (!getProviderCatalogEntry(providerId).needsKey) {
		return null;
	}
	const secretName = (readProvider(providerId, settings).apiKeySecretName ?? "").trim();
	if (!secretName) {
		return "needs-key";
	}
	return hasSecret(secretName) ? null : "key-missing";
}

export type SetupTone = "ok" | "warning" | "error" | "busy";

export interface SetupStageCopy {
	tone: SetupTone;
	headline: string;
	detail: string | null;
	/** The one button the interface offers, or null when nothing needs doing. */
	action: SetupAction | null;
	/** Short text for the status bar segment. */
	statusText: string;
}

/** Wording for each stage, so the card, status bar and settings page say the same thing. */
export function describeSetupStage(stage: SetupStage): SetupStageCopy {
	switch (stage.kind) {
		case "needs-key":
			return { tone: "warning", headline: `Add an API key for ${stage.label}`, detail: "Paste it once; AskMate stores it in Obsidian's secret storage.", action: SETUP_ACTIONS["update-key"], statusText: "Setup needed" };
		case "key-missing":
			return { tone: "warning", headline: `${stage.label} has no key on this device`, detail: "Keys are stored per device, so paste it again here.", action: SETUP_ACTIONS["update-key"], statusText: "Key missing" };
		case "needs-endpoint":
			return { tone: "warning", headline: stage.issues.find((issue) => issue.kind === "needs-endpoint")?.message ?? "Set the address", detail: null, action: SETUP_ACTIONS["check-address"], statusText: "Setup needed" };
		case "needs-model":
			return { tone: "warning", headline: "Enter your deployment name", detail: "Azure OpenAI answers with the deployment you created, not a model name.", action: SETUP_ACTIONS["choose-model"], statusText: "Setup needed" };
		case "untested":
			return { tone: "ok", headline: `${stage.label} is set up`, detail: "Test the connection to check the key and model.", action: SETUP_ACTIONS.test, statusText: stage.model };
		case "testing":
			return { tone: "busy", headline: `Testing the connection to ${stage.label}`, detail: null, action: null, statusText: "Testing" };
		case "test-failed":
			return { tone: "error", headline: stage.copy.message, detail: stage.copy.detail || null, action: stage.copy.action, statusText: "Connection failed" };
		case "ready":
			return { tone: "ok", headline: `Connected to ${stage.label}`, detail: stage.model ? `Model: ${stage.model}` : null, action: null, statusText: stage.model };
	}
}
