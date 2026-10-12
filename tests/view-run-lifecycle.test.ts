import { describe, expect, test } from "bun:test";
import { runGuardedAction, type GuardedActionHooks } from "../src/ui/sidebar/components/guardedAction";
import { planRetry, requestSignature, selectionSignature, type RetryTicket } from "../src/ui/sidebar/components/retry";
import { createRunController, BUSY_CLAIM_MESSAGE, BUSY_RUN_MESSAGE, type RunController } from "../src/ui/sidebar/runController";
import { createBuiltRetrySnapshot, createDraftRetrySnapshot } from "../src/shared/trustSafety";
import type { AskRequest } from "../src/shared/types";

const NOW = new Date("2026-10-12T10:00:00.000Z");

function request(overrides: { providerId?: string; model?: string; path?: string } = {}): AskRequest {
	return {
		context: { content: "text", file: overrides.path === "" ? null : { path: overrides.path ?? "Notes/A.md" }, source: "Current note" },
		question: "What is this?",
		title: "AskMate Answer",
		evidenceSources: [],
		metadata: {
			providerId: overrides.providerId ?? "openai",
			selectedModel: overrides.model ?? "gpt-5.5",
			reasoningEffort: "medium",
			intentKind: "freeform_text"
		}
	} as unknown as AskRequest;
}

/** A stand-in for the sidebar: the same claim and run calls the view makes, with the DOM left out. */
class FakeView {
	readonly controller: RunController = createRunController({ now: () => NOW });
	readonly notices: string[] = [];
	readonly started: Array<{ question: string; mode: "rebuild" | "reuse" }> = [];
	composer = "a question typed meanwhile";
	failNext: Error | null = null;
	signature = selectionSignature({ providerId: "openai", model: "gpt-5.5", effort: "medium", notePath: "Notes/A.md" } as never);
	ticket: RetryTicket | null = null;

	readonly hooks: GuardedActionHooks = {
		busy: (message) => this.notices.push(message),
		failed: (error) => this.notices.push(error instanceof Error ? error.message : String(error))
	};

	async runRequest(question: string, mode: "rebuild" | "reuse", ignoreKeys: readonly string[]): Promise<void> {
		const begun = this.controller.begin("freeform_text", { ignoreKeys });
		if (!begun.ok) {
			this.notices.push(begun.message);
			return;
		}
		this.started.push({ question, mode });
		this.ticket = { draft: createDraftRetrySnapshot(question, "AskMate Answer", {}, NOW.toISOString()), built: null };
		try {
			await Promise.resolve();
			if (this.failNext) {
				const error = this.failNext;
				this.failNext = null;
				throw error;
			}
		} finally {
			this.controller.finish(begun.run);
		}
	}

	retry(ticket: RetryTicket): Promise<unknown> {
		return runGuardedAction(this.controller, { lockKey: "Retry request", requiresIdle: true }, async ({ ignoreKeys }) => {
			const plan = planRetry(ticket, this.signature, this.controller, NOW);
			await this.runRequest(ticket.draft.question, plan.mode, ignoreKeys);
		}, this.hooks);
	}
}

describe("Retry through the run controller", () => {
	test("starts a request even though its own claim is held", async () => {
		const view = new FakeView();
		const ticket: RetryTicket = { draft: createDraftRetrySnapshot("Why?", "AskMate Answer", {}, NOW.toISOString()), built: null };
		await view.retry(ticket);
		expect(view.started).toEqual([{ question: "Why?", mode: "rebuild" }]);
		expect(view.notices).toEqual([]);
		expect(view.controller.getClaims()).toEqual([]);
	});

	test("a request that does not ignore the claim is refused, which was the old defect", async () => {
		const view = new FakeView();
		const claim = view.controller.claim("Retry request");
		expect(claim.ok).toBe(true);
		await view.runRequest("Why?", "rebuild", []);
		expect(view.started).toEqual([]);
		expect(view.notices).toEqual([BUSY_CLAIM_MESSAGE]);
	});

	test("leaves the text typed in the composer alone", async () => {
		const view = new FakeView();
		await view.retry({ draft: createDraftRetrySnapshot("Why?", "AskMate Answer", {}, NOW.toISOString()), built: null });
		expect(view.composer).toBe("a question typed meanwhile");
	});

	test("a second click while the first is working does nothing", async () => {
		const view = new FakeView();
		const ticket: RetryTicket = { draft: createDraftRetrySnapshot("Why?", "AskMate Answer", {}, NOW.toISOString()), built: null };
		const first = view.retry(ticket);
		const second = await view.retry(ticket);
		await first;
		// The first click's request is already running, so the second is refused with the busy notice.
		expect(second).toBe("busy");
		expect(view.started).toHaveLength(1);
	});

	test("is refused with the busy message while another request runs", async () => {
		const view = new FakeView();
		const running = view.controller.begin("freeform_text");
		expect(running.ok).toBe(true);
		const outcome = await view.retry({ draft: createDraftRetrySnapshot("Why?", "AskMate Answer", {}, NOW.toISOString()), built: null });
		expect(outcome).toBe("busy");
		expect(view.notices).toEqual([BUSY_RUN_MESSAGE]);
	});

	test("reports a failure and releases the claim so Retry can be used again", async () => {
		const view = new FakeView();
		const ticket: RetryTicket = { draft: createDraftRetrySnapshot("Why?", "AskMate Answer", {}, NOW.toISOString()), built: null };
		view.failNext = new Error("401");
		await view.retry(ticket);
		expect(view.notices).toEqual(["401"]);
		expect(view.controller.getClaims()).toEqual([]);
		await view.retry(ticket);
		expect(view.started).toHaveLength(2);
	});
});

describe("planRetry", () => {
	const draft = createDraftRetrySnapshot("What is this?", "AskMate Answer", {}, NOW.toISOString());
	const controller = createRunController({ now: () => NOW });
	const current = requestSignature(request());

	test("a request that failed before it was built is built again", () => {
		expect(planRetry({ draft, built: null }, current, controller, NOW)).toMatchObject({ mode: "rebuild", reason: "not-built" });
	});

	test("reuses the built request while nothing it captured has changed", () => {
		const built = createBuiltRetrySnapshot(request(), NOW.toISOString());
		const plan = planRetry({ draft, built }, current, controller, new Date(NOW.getTime() + 60_000));
		expect(plan.mode).toBe("reuse");
	});

	test("builds again after the model changed, so the new model is used", () => {
		const built = createBuiltRetrySnapshot(request({ model: "gpt-5.5" }), NOW.toISOString());
		const switched = requestSignature(request({ model: "gpt-5.5-mini" }));
		expect(planRetry({ draft, built }, switched, controller, NOW)).toMatchObject({ mode: "rebuild", reason: "changed" });
	});

	test("builds again after the provider changed", () => {
		const built = createBuiltRetrySnapshot(request(), NOW.toISOString());
		expect(planRetry({ draft, built }, requestSignature(request({ providerId: "anthropic" })), controller, NOW)).toMatchObject({ mode: "rebuild" });
	});

	test("builds again when the note moved on", () => {
		const built = createBuiltRetrySnapshot(request(), NOW.toISOString());
		expect(planRetry({ draft, built }, requestSignature(request({ path: "Notes/B.md" })), controller, NOW)).toMatchObject({ mode: "rebuild", reason: "changed" });
	});

	test("builds again when the snapshot is old", () => {
		const built = createBuiltRetrySnapshot(request(), NOW.toISOString());
		const later = new Date(NOW.getTime() + 11 * 60_000);
		expect(planRetry({ draft, built }, current, controller, later)).toMatchObject({ mode: "rebuild", reason: "stale" });
	});
});

describe("guarded actions", () => {
	test("an action that needs no claim just runs", async () => {
		const controller = createRunController();
		let ran = false;
		const outcome = await runGuardedAction(controller, { lockKey: "", requiresIdle: false }, () => {
			ran = true;
		}, { busy: () => undefined, failed: () => undefined });
		expect(outcome).toBe("ran");
		expect(ran).toBe(true);
	});

	test("holds the named claim while it works and tells the control when to disable and enable", async () => {
		const controller = createRunController();
		const events: string[] = [];
		let during: string[] = [];
		await runGuardedAction(controller, { lockKey: "mutation:Notes/A.md", requiresIdle: true }, () => {
			during = controller.getClaims();
		}, { busy: () => undefined, failed: () => undefined, started: () => events.push("started"), settled: () => events.push("settled") });
		expect(during).toEqual(["mutation:Notes/A.md"]);
		expect(controller.getClaims()).toEqual([]);
		expect(events).toEqual(["started", "settled"]);
	});

	test("a held claim blocks a new request until it is released", async () => {
		const controller = createRunController();
		const seen: Array<string | null> = [];
		await runGuardedAction(controller, { lockKey: "mutation:x", requiresIdle: false }, () => {
			seen.push(controller.getBusyMessage());
		}, { busy: () => undefined, failed: () => undefined });
		expect(seen).toEqual([BUSY_CLAIM_MESSAGE]);
		expect(controller.getBusyMessage()).toBeNull();
	});
});
