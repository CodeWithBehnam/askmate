import type { RequestIntentKind } from "../../shared/types";

/**
 * The sidebar's run lifecycle as plain state: which request is running, which phase it is in, which short-lived
 * claims (a provider check, a message action) are held, and what a stop or retry should do. It owns no Obsidian
 * objects and sends nothing, so the view only wires it to buttons and the rules are unit tested.
 */

/**
 * Phases a run moves through. The last two exist for tool calls; they are listed here so the controller and the
 * stop control already handle them when the shared RunPhase type gains them.
 */
export type RunControllerPhase = "building" | "confirming" | "generating" | "tool-calling" | "awaiting-approval" | "post-processing";

export interface RunRecord {
	id: number;
	abortController: AbortController;
	intentKind: RequestIntentKind;
	phase: RunControllerPhase;
	startedAt: string;
}

export type BusyReason = "run" | "claim";

export const BUSY_RUN_MESSAGE = "AskMate is already working. Stop the current request before starting another.";
export const BUSY_CLAIM_MESSAGE = "Wait for the current AskMate action to finish before starting another request.";
export const SAVING_REPLY_MESSAGE = "AskMate is saving the reply. Wait for it to finish.";

export type BeginResult = { ok: true; run: RunRecord } | { ok: false; reason: BusyReason; message: string };
export type ClaimResult = { ok: true; release: () => void } | { ok: false; reason: BusyReason; message: string };

export type StopOutcome =
	| { kind: "idle" }
	/** The reply has arrived and its write may be under way; unlocking now would report a stop that did not happen. */
	| { kind: "blocked"; message: string }
	| { kind: "stopped"; run: RunRecord; phase: RunControllerPhase; message: string };

export interface StopControl {
	visible: boolean;
	enabled: boolean;
	/** Accessible name and tooltip. */
	label: string;
	/** Short text for the Console layout. */
	consoleText: string;
}

export interface BeginOptions {
	/** Claims the caller itself holds (for example the "Retry request" button's own lock) that must not count as busy. */
	ignoreKeys?: Iterable<string>;
}

export interface RunControllerOptions {
	now?: () => Date;
}

export interface RunController {
	/** The run in progress, or null. */
	getActiveRun(): RunRecord | null;
	getClaims(): string[];
	/** Busy reason, or null when a new request may start. Claims named in `ignoreKeys` do not count. */
	getBusyReason(ignoreKeys?: Iterable<string>): BusyReason | null;
	/** The message to show when a new request is refused, or null when it may start. */
	getBusyMessage(ignoreKeys?: Iterable<string>): string | null;
	claim(key: string, options?: { requireIdle?: boolean }): ClaimResult;
	release(key: string): void;
	hasClaim(key: string): boolean;
	/** Holds a claim for the duration of `task`, releasing it whatever the outcome. */
	withClaim<T>(key: string, task: () => Promise<T>, options?: { requireIdle?: boolean }): Promise<{ ok: true; value: T } | { ok: false; reason: BusyReason; message: string }>;
	begin(intentKind: RequestIntentKind, options?: BeginOptions): BeginResult;
	setPhase(run: RunRecord, phase: RunControllerPhase): boolean;
	isCurrent(run: RunRecord): boolean;
	/** True while the run is still the active one, was not aborted, and the view is open. */
	canContinue(run: RunRecord, viewClosed: boolean): boolean;
	/** `notify` is false when the view is closing, so a closing view never reports a stop to the user. */
	stop(options?: { notify?: boolean }): StopOutcome;
	/** Ends the run if it is still the active one. Returns false for a run that was stopped or replaced. */
	finish(run: RunRecord): boolean;
	/** Aborts any run and drops every claim. For when the view closes. */
	shutdown(): void;
	describeStopControl(): StopControl;
	/** See `retryDecision`; `now` defaults to the controller's clock. */
	retryDecision(input: Omit<RetryDecisionInput, "now"> & { now?: Date }): RetryDecision;
}

const STOP_MESSAGES: Record<RunControllerPhase, string> = {
	building: "AskMate stopped this request before sending it.",
	confirming: "AskMate stopped this request before sending it.",
	generating: "AskMate stopped waiting for this request. The provider may still finish it in the background.",
	"tool-calling": "AskMate stopped this request. A tool that had already started may still finish.",
	"awaiting-approval": "AskMate stopped this request. No further tools will run.",
	"post-processing": SAVING_REPLY_MESSAGE
};

export function describeStopMessage(phase: RunControllerPhase): string {
	return STOP_MESSAGES[phase];
}

export function createRunController(options: RunControllerOptions = {}): RunController {
	const now = options.now ?? ((): Date => new Date());
	const claims = new Set<string>();
	let active: RunRecord | null = null;
	let nextId = 0;

	const busyReason = (ignoreKeys: Iterable<string> = []): BusyReason | null => {
		if (active) {
			return "run";
		}
		const ignored = new Set(ignoreKeys);
		return Array.from(claims).some((key) => !ignored.has(key)) ? "claim" : null;
	};
	const messageFor = (reason: BusyReason | null): string | null => reason === "run" ? BUSY_RUN_MESSAGE : reason === "claim" ? BUSY_CLAIM_MESSAGE : null;

	const controller: RunController = {
		getActiveRun: () => active,
		getClaims: () => Array.from(claims),
		getBusyReason: busyReason,
		getBusyMessage: (ignoreKeys) => messageFor(busyReason(ignoreKeys)),
		hasClaim: (key) => claims.has(key),
		claim(key, claimOptions = {}) {
			if (claimOptions.requireIdle && active) {
				return { ok: false, reason: "run", message: BUSY_RUN_MESSAGE };
			}
			if (claims.has(key)) {
				return { ok: false, reason: "claim", message: BUSY_CLAIM_MESSAGE };
			}
			claims.add(key);
			return { ok: true, release: () => controller.release(key) };
		},
		release(key) {
			claims.delete(key);
		},
		async withClaim(key, task, claimOptions) {
			const claimed = controller.claim(key, claimOptions);
			if (!claimed.ok) {
				return claimed;
			}
			try {
				return { ok: true, value: await task() };
			} finally {
				claimed.release();
			}
		},
		begin(intentKind, beginOptions = {}) {
			const reason = busyReason(beginOptions.ignoreKeys);
			if (reason) {
				return { ok: false, reason, message: messageFor(reason) ?? BUSY_CLAIM_MESSAGE };
			}
			nextId += 1;
			const run: RunRecord = {
				id: nextId,
				abortController: new AbortController(),
				intentKind,
				phase: "building",
				startedAt: now().toISOString()
			};
			active = run;
			return { ok: true, run };
		},
		setPhase(run, phase) {
			if (active?.id !== run.id) {
				return false;
			}
			run.phase = phase;
			return true;
		},
		isCurrent: (run) => active?.id === run.id,
		canContinue: (run, viewClosed) => !viewClosed && !run.abortController.signal.aborted && active?.id === run.id,
		stop(stopOptions = {}) {
			const run = active;
			if (!run) {
				return { kind: "idle" };
			}
			const notify = stopOptions.notify ?? true;
			if (notify && run.phase === "post-processing") {
				return { kind: "blocked", message: SAVING_REPLY_MESSAGE };
			}
			const phase = run.phase;
			run.abortController.abort();
			active = null;
			return { kind: "stopped", run, phase, message: STOP_MESSAGES[phase] };
		},
		finish(run) {
			if (active?.id !== run.id) {
				return false;
			}
			active = null;
			return true;
		},
		shutdown() {
			active?.abortController.abort();
			active = null;
			claims.clear();
		},
		retryDecision: (input) => retryDecision({ ...input, now: input.now ?? now() }),
		describeStopControl() {
			if (!active) {
				return { visible: false, enabled: false, label: "Stop request", consoleText: "stop" };
			}
			const saving = active.phase === "post-processing";
			const label = saving ? "Saving reply" : "Stop request";
			return { visible: true, enabled: !saving, label, consoleText: saving ? "saving" : "stop" };
		}
	};
	return controller;
}

export type RetrySnapshotKind = "draft" | "built";

export type RetryReason = "not-built" | "changed" | "stale" | "unchanged";

export interface RetryDecision {
	mode: "rebuild" | "reuse";
	reason: RetryReason;
}

export const DEFAULT_RETRY_MAX_AGE_MS = 10 * 60 * 1000;

export interface RetryDecisionInput {
	snapshotKind: RetrySnapshotKind;
	/** ISO 8601 time the snapshot was made. */
	createdAt: string;
	now: Date;
	/** Describes what the built request captured, taken when it failed. */
	capturedSignature: string;
	/** The same description taken now. */
	currentSignature: string;
	maxAgeMs?: number;
}

/**
 * Whether Retry should send the request it already built or build a fresh one.
 *
 * A request that failed before it was fully built has nothing to reuse. A built request is reused only while the
 * things it captured still hold: `signature` (for example provider, model and note path) is unchanged and the
 * snapshot is recent enough that the note has probably not moved on. Otherwise Retry would resend an old model or
 * stale note text after the user changed either.
 */
export function retryDecision(input: RetryDecisionInput): RetryDecision {
	if (input.snapshotKind === "draft") {
		return { mode: "rebuild", reason: "not-built" };
	}
	if (input.capturedSignature !== input.currentSignature) {
		return { mode: "rebuild", reason: "changed" };
	}
	const created = Date.parse(input.createdAt);
	const maxAge = input.maxAgeMs ?? DEFAULT_RETRY_MAX_AGE_MS;
	if (Number.isNaN(created) || input.now.getTime() - created > maxAge) {
		return { mode: "rebuild", reason: "stale" };
	}
	return { mode: "reuse", reason: "unchanged" };
}
