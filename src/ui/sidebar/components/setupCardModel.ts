import {
	describeSetupStage,
	getProviderCatalogEntry,
	isReadyToSend,
	listSetupCardProviders,
	SETUP_CARD_PROVIDER_IDS,
	starterChipsFor,
	type ProviderCatalogEntry,
	type SetupAction,
	type SetupStage,
	type StarterChip
} from "../../../setup";
import { TEXT_PROVIDER_LABELS } from "../../../settings/constants";
import type { TextProviderId } from "../../../shared/types";

/**
 * What the Connect card shows. It is a pure function of the setup stage and three flags, so the card, the status
 * segment and the settings page cannot tell different stories. The view draws the result and wires the buttons.
 */

export type SetupCardPhase = "connect" | "testing" | "failed" | "connected";

export interface SetupCardInput {
	stage: SetupStage;
	/** The provider chip the person picked. It may differ from the chat provider until Connect is pressed. */
	selectedProvider: TextProviderId;
	/** True while the person is using the card: first run, /setup, or a connection attempt. */
	flowOpen: boolean;
	/** True after a successful connection or /welcome, until a starter is chosen or the card is dismissed. */
	welcomeOpen: boolean;
	hasOpenNote: boolean;
	/** True when the secret store holds a value for the selected provider's saved key name. */
	hasStoredKey: boolean;
	/** A problem found before anything was sent, such as an empty key field. It outranks the stage's own error. */
	localError?: SetupCardError | null;
	/** The address and model saved for the selected provider. A local server keeps its own port, so the card must start from it. */
	savedBaseUrl?: string;
	savedModel?: string;
}

export interface SetupProviderChip {
	id: TextProviderId;
	label: string;
	selected: boolean;
}

export interface SetupStepModel {
	id: "provider" | "key" | "start";
	label: string;
	state: "done" | "current" | "todo";
}

export interface SetupCardError {
	message: string;
	detail: string | null;
	action: SetupAction;
}

export interface SetupCardModel {
	visible: boolean;
	phase: SetupCardPhase;
	title: string;
	detail: string;
	providers: SetupProviderChip[];
	provider: ProviderCatalogEntry;
	showKeyField: boolean;
	showAddressField: boolean;
	/** What the address field shows until something is typed: the saved address, or the provider's usual one. */
	addressDefault: string;
	/** What the model field suggests until something is typed: the saved model, or the provider's usual one. */
	modelPlaceholder: string;
	/** A line saying where the providers the chips leave out are set up; only on the first step. */
	otherProvidersHint: string | null;
	hasStoredKey: boolean;
	primaryLabel: string;
	/** What the main button does: connect from this card, or hand over to the settings page for a provider the card cannot finish. */
	primaryAction: "connect" | "open-settings";
	error: SetupCardError | null;
	steps: SetupStepModel[];
	starters: StarterChip[];
	privacy: string;
}

export const SETUP_PRIVACY_LINE =
	"AskMate sends your question, the note or selection you ask about, and recent turns of this conversation to the provider you choose, plus any extra context or skills you turn on. Pictures from /image and the Image button go to OpenAI, and tools you allow send their arguments to the servers you trust. AskMate has no telemetry. A cloud provider charges you for what you send. Conversations are saved in this vault's plugin data (data.json), and you can delete them in settings.";

const OTHER_PROVIDER_IDS: readonly TextProviderId[] = ["azure-openai", "azure-ai", "openrouter"];
const NO_NOTE_STARTERS_HINT = "Open a note, then pick a starter. They work on the note you have open.";

const HIDDEN_PHASE: SetupCardPhase = "connect";

/** The stage that belongs to the chosen chip, or null when the chip is not the chat provider yet. */
function stageFor(stage: SetupStage, selected: TextProviderId): SetupStage | null {
	return stage.providerId === selected ? stage : null;
}

/**
 * True when a key, or an address for a local server, is everything the provider needs. Azure also needs a deployment
 * name or an endpoint, which the card has no fields for, so those providers are finished on the settings page.
 */
export function canFinishInCard(provider: ProviderCatalogEntry): boolean {
	return !provider.needsKey || !provider.needsEndpoint;
}

/**
 * The chips: the four first-run providers, plus the chat provider and the chosen one when they are something else
 * (OpenRouter, Azure), so a person who already uses one of those is never moved to OpenAI by opening the card.
 */
function chipEntries(stage: SetupStage, selected: TextProviderId): ProviderCatalogEntry[] {
	const extras = Array.from(new Set([stage.providerId, selected]))
		.filter((id) => !SETUP_CARD_PROVIDER_IDS.includes(id))
		.map(getProviderCatalogEntry);
	return [...extras, ...listSetupCardProviders()];
}

function derivePhase(stage: SetupStage | null, input: SetupCardInput): SetupCardPhase | null {
	if (stage === null) {
		return input.flowOpen ? "connect" : null;
	}
	if (!isReadyToSend(stage)) {
		return "connect";
	}
	if (stage.kind === "testing") {
		return "testing";
	}
	if (stage.kind === "test-failed") {
		return input.flowOpen ? "failed" : null;
	}
	if (stage.kind === "ready") {
		return input.flowOpen || input.welcomeOpen ? "connected" : null;
	}
	// Untested: a provider with a key that has not been checked yet. The card appears only when the person asked for it.
	return input.flowOpen ? "connect" : input.welcomeOpen ? "connected" : null;
}

function buildSteps(phase: SetupCardPhase, provider: ProviderCatalogEntry, finishInSettings: boolean): SetupStepModel[] {
	const second = finishInSettings ? "Finish in settings" : provider.needsKey ? "Paste your key" : "Check the address";
	const current = phase === "connected" ? 2 : 1;
	return [
		{ id: "provider", label: "Choose a provider" },
		{ id: "key", label: second },
		{ id: "start", label: "Try a starter" }
	].map((step, index) => ({
		id: step.id as SetupStepModel["id"],
		label: step.label,
		state: index < current ? "done" : index === current ? "current" : "todo"
	}));
}

function titleFor(phase: SetupCardPhase, provider: ProviderCatalogEntry, finishInSettings: boolean): string {
	switch (phase) {
		case "connect":
			return finishInSettings ? `Finish setting up ${provider.label}` : "Connect an AI provider";
		case "testing":
			return `Checking ${provider.label}`;
		case "failed":
			return "AskMate could not connect";
		case "connected":
			return `Connected to ${provider.label}`;
	}
}

function detailFor(phase: SetupCardPhase, provider: ProviderCatalogEntry, hasStoredKey: boolean, hasOpenNote: boolean): string {
	switch (phase) {
		case "connect":
			if (!provider.needsKey) {
				return "Run a model on this computer or network. AskMate needs its address, and no key.";
			}
			return hasStoredKey
				? "A key is already stored on this device. Test the connection, or paste a new key to replace it."
				: "Paste your key once. AskMate keeps it in Obsidian's secret storage on this device (your system keychain), never in your notes.";
		case "testing":
			return "This takes a few seconds.";
		case "failed":
			return "Fix the problem below, then try again.";
		case "connected":
			return hasOpenNote ? "Pick a starter to see what AskMate does with the note you have open." : NO_NOTE_STARTERS_HINT;
	}
}

/** "Azure OpenAI, Azure AI Foundry or OpenRouter" from the labels the settings page uses. */
function describeOtherProviders(): string {
	const labels = OTHER_PROVIDER_IDS.map((id) => TEXT_PROVIDER_LABELS[id]);
	return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** For a provider the card cannot fill in: the gap in the stage's own words and why it is closed in settings, or a test offer when nothing is missing. */
function settingsDetail(stage: SetupStage | null, provider: ProviderCatalogEntry, finishInSettings: boolean): string {
	if (!finishInSettings) {
		return `${provider.label} is set up. Test the connection, or open AskMate settings to change its key or address.`;
	}
	const gap = stage ? describeSetupStage(stage).headline.replace(/\.$/, "") : `Set up ${provider.label}`;
	return `${gap}. ${provider.label} needs an address as well as a key, so it is set up in AskMate settings.`;
}

function primaryLabelFor(phase: SetupCardPhase, provider: ProviderCatalogEntry, hasStoredKey: boolean, finishInSettings: boolean): string {
	if (phase === "testing") {
		return "Testing...";
	}
	if (phase === "failed") {
		return "Try again";
	}
	if (finishInSettings) {
		return "Open settings";
	}
	return provider.needsKey && hasStoredKey ? "Test connection" : "Connect";
}

export function deriveSetupCardModel(input: SetupCardInput): SetupCardModel {
	const provider = getProviderCatalogEntry(input.selectedProvider);
	const stage = stageFor(input.stage, input.selectedProvider);
	const phase = derivePhase(stage, input);
	// A problem found before anything was sent (a bad address, say) means the person is still connecting: the card must
	// not say "Connected" beside the error, and it keeps the fields so the problem can be fixed there.
	const shown: SetupCardPhase = phase === "connected" && input.localError ? "connect" : phase ?? HIDDEN_PHASE;
	const providers = chipEntries(input.stage, input.selectedProvider).map((entry) => ({ id: entry.id, label: entry.chipLabel, selected: entry.id === input.selectedProvider }));
	const failure = stage?.kind === "test-failed" ? stage.copy : null;
	// A provider that needs more than this card can ask for (Azure) is finished on the settings page while something is missing.
	const finishInSettings = !canFinishInCard(provider) && shown !== "connected" && (stage === null || !isReadyToSend(stage));
	const fields = canFinishInCard(provider) && shown !== "connected";
	return {
		visible: phase !== null,
		phase: shown,
		title: titleFor(shown, provider, finishInSettings),
		detail: !canFinishInCard(provider) && shown === "connect" ? settingsDetail(stage, provider, finishInSettings) : detailFor(shown, provider, input.hasStoredKey, input.hasOpenNote),
		providers,
		provider,
		showKeyField: provider.needsKey && fields,
		showAddressField: !provider.needsKey && fields,
		addressDefault: input.savedBaseUrl?.trim() || provider.defaultBaseUrl,
		modelPlaceholder: input.savedModel?.trim() || provider.defaultModel,
		// Shown only while no chip stands for one of those providers, so a person who uses one is never told to look elsewhere.
		otherProvidersHint: shown === "connect" && providers.length === SETUP_CARD_PROVIDER_IDS.length
			? `Using ${describeOtherProviders()}? Choose Open settings, then Chat provider.`
			: null,
		hasStoredKey: input.hasStoredKey,
		primaryLabel: primaryLabelFor(shown, provider, input.hasStoredKey, finishInSettings),
		primaryAction: finishInSettings ? "open-settings" : "connect",
		error: input.localError ?? (failure ? { message: failure.message, detail: failure.detail || null, action: failure.action } : null),
		steps: buildSteps(shown, provider, finishInSettings),
		starters: shown === "connected" ? starterChipsFor(input.hasOpenNote) : [],
		privacy: SETUP_PRIVACY_LINE
	};
}

/**
 * The card is told about a test that just ran: a test run from this view can be newer than what the plugin's stage
 * remembers. A result for the same provider and model replaces a stage that is complete (untested, ready or failed),
 * and never one that still lacks a key, an address or a model.
 */
export function overlayTestResult(
	stage: SetupStage,
	local: { status: "ok" | "failed"; providerId: TextProviderId; model: string; copy?: Extract<SetupStage, { kind: "test-failed" }>["copy"] } | null
): SetupStage {
	const complete = stage.kind === "untested" || stage.kind === "ready" || stage.kind === "test-failed";
	if (!local || !complete || local.providerId !== stage.providerId || local.model !== stage.model) {
		return stage;
	}
	if (local.status === "ok") {
		return { providerId: stage.providerId, label: stage.label, model: stage.model, kind: "ready" };
	}
	return local.copy
		? { providerId: stage.providerId, label: stage.label, model: stage.model, kind: "test-failed", copy: local.copy }
		: stage;
}
