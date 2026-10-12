import { describe, expect, test } from "bun:test";
import {
	BUSY_CLAIM_MESSAGE,
	BUSY_RUN_MESSAGE,
	DEFAULT_RETRY_MAX_AGE_MS,
	SAVING_REPLY_MESSAGE,
	createRunController,
	describeStopMessage,
	retryDecision,
	type RunControllerPhase
} from "../src/ui/sidebar/runController";

const FIXED = new Date("2026-10-12T09:00:00.000Z");

function controller() {
	return createRunController({ now: () => FIXED });
}

function begun(instance = controller()) {
	const result = instance.begin("freeform_text");
	if (!result.ok) {
		throw new Error("expected the run to begin");
	}
	return { instance, run: result.run };
}

describe("begin and finish", () => {
	test("a run starts in the building phase with a unique id and the clock's time", () => {
		const { instance, run } = begun();
		expect(run.phase).toBe("building");
		expect(run.startedAt).toBe("2026-10-12T09:00:00.000Z");
		expect(instance.getActiveRun()).toBe(run);
		instance.finish(run);
		const next = instance.begin("workflow");
		expect(next.ok && next.run.id).toBe(run.id + 1);
	});

	test("a second request is refused while one runs", () => {
		const { instance } = begun();
		const second = instance.begin("freeform_text");
		expect(second).toEqual({ ok: false, reason: "run", message: BUSY_RUN_MESSAGE });
	});

	test("finish only ends the run it was given", () => {
		const { instance, run } = begun();
		const stale = { ...run, id: run.id + 99 };
		expect(instance.finish(stale)).toBe(false);
		expect(instance.getActiveRun()).toBe(run);
		expect(instance.finish(run)).toBe(true);
		expect(instance.getActiveRun()).toBeNull();
		expect(instance.finish(run)).toBe(false);
	});
});

describe("claims and ignoreKeys", () => {
	test("a held claim blocks a new request with the action message", () => {
		const instance = controller();
		expect(instance.claim("submit").ok).toBe(true);
		expect(instance.begin("freeform_text")).toEqual({ ok: false, reason: "claim", message: BUSY_CLAIM_MESSAGE });
		expect(instance.getBusyMessage()).toBe(BUSY_CLAIM_MESSAGE);
	});

	test("ignoreKeys lets an action start the run its own lock guards", () => {
		const instance = controller();
		instance.claim("Retry request", { requireIdle: true });
		expect(instance.begin("freeform_text").ok).toBe(false);
		const result = instance.begin("freeform_text", { ignoreKeys: ["Retry request"] });
		expect(result.ok).toBe(true);
	});

	test("ignoreKeys does not hide other claims or a running request", () => {
		const instance = controller();
		instance.claim("Retry request");
		instance.claim("submit");
		expect(instance.getBusyReason(["Retry request"])).toBe("claim");
		instance.release("submit");
		expect(instance.getBusyReason(["Retry request"])).toBeNull();
		expect(instance.begin("freeform_text", { ignoreKeys: ["Retry request"] }).ok).toBe(true);
		expect(instance.getBusyReason(["Retry request"])).toBe("run");
	});

	test("the same claim cannot be taken twice, and release frees it", () => {
		const instance = controller();
		const first = instance.claim("Copy");
		expect(first.ok).toBe(true);
		expect(instance.claim("Copy").ok).toBe(false);
		expect(instance.hasClaim("Copy")).toBe(true);
		if (first.ok) {
			first.release();
		}
		expect(instance.hasClaim("Copy")).toBe(false);
		expect(instance.claim("Copy").ok).toBe(true);
	});

	test("requireIdle refuses a claim while a request runs", () => {
		const { instance } = begun();
		expect(instance.claim("Retry request", { requireIdle: true })).toEqual({ ok: false, reason: "run", message: BUSY_RUN_MESSAGE });
		expect(instance.claim("Copy").ok).toBe(true);
	});

	test("withClaim releases the claim when the task throws", async () => {
		const instance = controller();
		await expect(instance.withClaim("submit", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		expect(instance.hasClaim("submit")).toBe(false);
		const ok = await instance.withClaim("submit", () => Promise.resolve(42));
		expect(ok).toEqual({ ok: true, value: 42 });
		instance.claim("submit");
		const refused = await instance.withClaim("submit", () => Promise.resolve(1));
		expect(refused.ok).toBe(false);
	});

	test("a claim held during a task is visible to begin", async () => {
		const instance = controller();
		const seen: { message: string | null } = { message: null };
		await instance.withClaim("submit", () => {
			seen.message = instance.getBusyMessage();
			return Promise.resolve();
		});
		expect(seen.message).toBe(BUSY_CLAIM_MESSAGE);
		expect(instance.getBusyMessage()).toBeNull();
	});
});

describe("phases", () => {
	test("setPhase moves the current run and ignores a stale one", () => {
		const { instance, run } = begun();
		const phases: RunControllerPhase[] = ["confirming", "generating", "tool-calling", "awaiting-approval", "generating", "post-processing"];
		for (const phase of phases) {
			expect(instance.setPhase(run, phase)).toBe(true);
			expect(run.phase).toBe(phase);
		}
		instance.finish(run);
		expect(instance.setPhase(run, "generating")).toBe(false);
		expect(run.phase).toBe("post-processing");
	});

	test("canContinue is false once stopped, replaced or when the view closed", () => {
		const { instance, run } = begun();
		expect(instance.canContinue(run, false)).toBe(true);
		expect(instance.canContinue(run, true)).toBe(false);
		instance.stop();
		expect(instance.canContinue(run, false)).toBe(false);
		expect(run.abortController.signal.aborted).toBe(true);
	});
});

describe("stop", () => {
	test("is idle when nothing runs", () => {
		expect(controller().stop()).toEqual({ kind: "idle" });
	});

	test("aborts the run and says what stopped, by phase", () => {
		const expectations: Array<[RunControllerPhase, string]> = [
			["building", "AskMate stopped this request before sending it."],
			["confirming", "AskMate stopped this request before sending it."],
			["generating", "AskMate stopped waiting for this request. The provider may still finish it in the background."],
			["tool-calling", "AskMate stopped this request. A tool that had already started may still finish."],
			["awaiting-approval", "AskMate stopped this request. No further tools will run."]
		];
		for (const [phase, message] of expectations) {
			const { instance, run } = begun();
			instance.setPhase(run, phase);
			const outcome = instance.stop();
			expect(outcome).toEqual({ kind: "stopped", run, phase, message });
			expect(describeStopMessage(phase)).toBe(message);
			expect(instance.getActiveRun()).toBeNull();
			expect(run.abortController.signal.aborted).toBe(true);
		}
	});

	test("refuses to stop while the reply is being saved", () => {
		const { instance, run } = begun();
		instance.setPhase(run, "post-processing");
		expect(instance.stop()).toEqual({ kind: "blocked", message: SAVING_REPLY_MESSAGE });
		expect(instance.getActiveRun()).toBe(run);
		expect(run.abortController.signal.aborted).toBe(false);
	});

	test("a closing view stops even a saving run, without notifying", () => {
		const { instance, run } = begun();
		instance.setPhase(run, "post-processing");
		const outcome = instance.stop({ notify: false });
		expect(outcome.kind).toBe("stopped");
		expect(run.abortController.signal.aborted).toBe(true);
	});

	test("shutdown aborts the run and drops every claim", () => {
		const { instance, run } = begun();
		instance.claim("submit");
		instance.shutdown();
		expect(run.abortController.signal.aborted).toBe(true);
		expect(instance.getActiveRun()).toBeNull();
		expect(instance.getClaims()).toEqual([]);
		expect(instance.begin("freeform_text").ok).toBe(true);
	});
});

describe("stop control", () => {
	test("is hidden when idle, enabled while running and disabled while saving", () => {
		const { instance, run } = begun(controller());
		expect(instance.describeStopControl()).toEqual({ visible: true, enabled: true, label: "Stop request", consoleText: "stop" });
		instance.setPhase(run, "post-processing");
		expect(instance.describeStopControl()).toEqual({ visible: true, enabled: false, label: "Saving reply", consoleText: "saving" });
		instance.finish(run);
		expect(instance.describeStopControl().visible).toBe(false);
	});
});

describe("retryDecision", () => {
	const base = {
		snapshotKind: "built" as const,
		createdAt: "2026-10-12T08:58:00.000Z",
		now: FIXED,
		capturedSignature: "openai|gpt-5.5|Note.md",
		currentSignature: "openai|gpt-5.5|Note.md"
	};

	test("a request that never finished building is rebuilt", () => {
		expect(retryDecision({ ...base, snapshotKind: "draft" })).toEqual({ mode: "rebuild", reason: "not-built" });
	});

	test("a recent built request with an unchanged signature is reused", () => {
		expect(retryDecision(base)).toEqual({ mode: "reuse", reason: "unchanged" });
	});

	test("a changed model, provider or note rebuilds", () => {
		expect(retryDecision({ ...base, currentSignature: "openai|gpt-4.1|Note.md" })).toEqual({ mode: "rebuild", reason: "changed" });
		expect(retryDecision({ ...base, currentSignature: "anthropic|claude|Note.md" }).mode).toBe("rebuild");
		expect(retryDecision({ ...base, currentSignature: "openai|gpt-5.5|Other.md" }).mode).toBe("rebuild");
	});

	test("an old snapshot is rebuilt because the note may have changed", () => {
		const old = new Date(FIXED.getTime() - DEFAULT_RETRY_MAX_AGE_MS - 1).toISOString();
		expect(retryDecision({ ...base, createdAt: old })).toEqual({ mode: "rebuild", reason: "stale" });
		const justInside = new Date(FIXED.getTime() - DEFAULT_RETRY_MAX_AGE_MS).toISOString();
		expect(retryDecision({ ...base, createdAt: justInside }).mode).toBe("reuse");
		expect(retryDecision({ ...base, createdAt: old, maxAgeMs: DEFAULT_RETRY_MAX_AGE_MS * 2 }).mode).toBe("reuse");
	});

	test("the controller offers the same decision with its own clock", () => {
		const instance = controller();
		expect(instance.retryDecision({ snapshotKind: "built", createdAt: base.createdAt, capturedSignature: "a", currentSignature: "a" })).toEqual({ mode: "reuse", reason: "unchanged" });
		expect(instance.retryDecision({ snapshotKind: "built", createdAt: base.createdAt, capturedSignature: "a", currentSignature: "b" }).mode).toBe("rebuild");
		expect(instance.retryDecision({ snapshotKind: "built", createdAt: base.createdAt, capturedSignature: "a", currentSignature: "a", now: new Date(FIXED.getTime() + DEFAULT_RETRY_MAX_AGE_MS * 2) }).reason).toBe("stale");
	});

	test("an unreadable timestamp is treated as stale", () => {
		expect(retryDecision({ ...base, createdAt: "not a date" }).reason).toBe("stale");
	});
});
