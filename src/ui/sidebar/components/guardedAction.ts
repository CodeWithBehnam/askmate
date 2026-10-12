import { BUSY_RUN_MESSAGE, type RunController } from "../runController";

/**
 * Runs a message action under the run controller's claim model. An action that must not overlap a request (it
 * needs the sidebar idle) is refused while one runs; an action that mutates something holds a named claim while it
 * works, so a second click or a new request is refused with the usual busy notice.
 *
 * The task receives the key it holds, so an action that itself starts a request (Retry) can pass it to `begin` as an
 * ignored key. Without that, the request would find its own claim and refuse to start.
 */

export interface GuardedActionSpec {
	/** The claim to hold while the task runs. Empty for an action that needs none. */
	lockKey: string;
	/** True when the task must not start while a request runs. */
	requiresIdle: boolean;
}

export interface GuardedActionHooks {
	/** The action was refused because a request is running. */
	busy(message: string): void;
	failed(error: unknown): void;
	/** The claim was taken; use it to disable the control. */
	started?(): void;
	/** The task ended (any outcome) and the claim is released; use it to enable the control again. */
	settled?(): void;
}

export interface GuardedTaskContext {
	/** Claims the task holds itself. Pass as `ignoreKeys` to a request it starts. */
	ignoreKeys: readonly string[];
}

export type GuardedOutcome = "ran" | "busy" | "claimed" | "failed";

export async function runGuardedAction(
	controller: RunController,
	spec: GuardedActionSpec,
	task: (context: GuardedTaskContext) => void | Promise<void>,
	hooks: GuardedActionHooks
): Promise<GuardedOutcome> {
	if (spec.requiresIdle && controller.getActiveRun()) {
		hooks.busy(BUSY_RUN_MESSAGE);
		return "busy";
	}
	let release: (() => void) | null = null;
	if (spec.lockKey) {
		const claim = controller.claim(spec.lockKey);
		if (!claim.ok) {
			// The same action is already running; a second click does nothing.
			return "claimed";
		}
		release = claim.release;
	}
	hooks.started?.();
	try {
		await task({ ignoreKeys: spec.lockKey ? [spec.lockKey] : [] });
		return "ran";
	} catch (error) {
		hooks.failed(error);
		return "failed";
	} finally {
		release?.();
		hooks.settled?.();
	}
}
