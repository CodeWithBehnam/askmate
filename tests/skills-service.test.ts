import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_SKILL_FILE_BYTES,
	SKILL_RESCAN_DEBOUNCE_MS,
	SkillService,
	hashSkillText,
	type SkillConfig,
	type SkillFileInfo,
	type SkillHost
} from "../src/skills";

const FOLDER = "AskMate/Skills";
const skillText = (name: string, body = "# Goal\nDo the thing.", description = `Handles ${name}.`): string => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

class FakeHost implements SkillHost {
	files = new Map<string, string>();
	trusted: Record<string, string> = {};
	config: Omit<SkillConfig, "trusted"> = { enabled: true, folder: FOLDER, matchMode: "builtin-auto", disabledIds: [] };
	listCalls = 0;
	readCalls: string[] = [];
	hashCalls = 0;
	warnings: string[] = [];
	failListing = false;
	failReading = new Set<string>();
	listDelay: Promise<void> | null = null;
	sizeOverrides = new Map<string, number>();
	watchCalls = 0;
	watchError: Error | null = null;
	private watchers = new Set<(path: string) => void>();
	private timers = new Map<number, () => void>();
	private nextTimer = 1;
	lastTimerDelay = 0;

	parsed = 0;

	// Real methods, not arrow properties: the service must keep `this` when it hands them to the pure code.
	parseYaml(text: string): unknown {
		this.parsed += 1;
		return Bun.YAML.parse(text);
	}

	async sha256(text: string): Promise<string> {
		this.hashCalls += 1;
		return hashSkillText(text);
	}

	getConfig(): SkillConfig {
		return { ...this.config, trusted: { ...this.trusted } };
	}

	async listFiles(): Promise<readonly SkillFileInfo[]> {
		this.listCalls += 1;
		if (this.listDelay) {
			await this.listDelay;
		}
		if (this.failListing) {
			throw new Error("listing failed");
		}
		return Array.from(this.files, ([path, text]) => ({ path, size: this.sizeOverrides.get(path) ?? new TextEncoder().encode(text).length }));
	}

	async readFile(path: string): Promise<string> {
		this.readCalls.push(path);
		if (this.failReading.has(path)) {
			throw new Error("read failed");
		}
		return this.files.get(path) ?? "";
	}

	async saveTrust(id: string, hash: string | null): Promise<void> {
		if (hash === null) {
			delete this.trusted[id];
		} else {
			this.trusted[id] = hash;
		}
	}

	watch(callback: (path: string) => void): () => void {
		this.watchCalls += 1;
		if (this.watchError) {
			throw this.watchError;
		}
		this.watchers.add(callback);
		return () => {
			this.watchers.delete(callback);
		};
	}

	setTimer(callback: () => void, delayMs: number): unknown {
		const id = this.nextTimer++;
		this.timers.set(id, callback);
		this.lastTimerDelay = delayMs;
		return id;
	}

	clearTimer(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	warn(message: string): void {
		this.warnings.push(message);
	}

	emit(path: string): void {
		for (const watcher of Array.from(this.watchers)) {
			watcher(path);
		}
	}

	get watcherCount(): number {
		return this.watchers.size;
	}

	get pendingTimers(): number {
		return this.timers.size;
	}

	/** Empties the timer table and returns the callbacks, so a test can fire one after the service cancelled it. */
	takeTimers(): Array<() => void> {
		const due = Array.from(this.timers.values());
		this.timers.clear();
		return due;
	}

	async runTimers(): Promise<void> {
		const due = Array.from(this.timers.values());
		this.timers.clear();
		for (const callback of due) {
			callback();
		}
		await Promise.resolve();
	}
}

async function started(host = new FakeHost()): Promise<{ host: FakeHost; service: SkillService }> {
	const service = new SkillService(host);
	await service.scan();
	return { host, service };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("SkillService catalogue", () => {
	test("lists nothing before the first scan, then the built-in skill and the vault's skills", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		host.files.set(`${FOLDER}/quick.md`, skillText("quick"));
		const service = new SkillService(host);
		expect(service.list()).toEqual([]);
		expect(service.isReady()).toBe(false);
		await service.scan();
		expect(service.isReady()).toBe(true);
		expect(service.list().map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams", "vault:notes", "vault:quick"]);
		expect(service.issues()).toEqual([]);
	});

	test("an empty or missing folder still yields the built-in skill", async () => {
		const { service } = await started();
		expect(service.list().map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams"]);
	});

	test("vault skills start in needs-review and become ready when the user approves their hash", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		const { service } = await started(host);
		const skill = service.get("vault:notes");
		expect(skill).not.toBeNull();
		expect(service.statusOf(skill!)).toBe("needs-review");
		expect(service.resolve({ request: "x", explicit: ["notes"] }).skills).toEqual([]);

		await service.trust(skill!.id, skill!.hash);
		expect(service.statusOf(skill!)).toBe("ready");
		expect(service.resolve({ request: "x", explicit: ["notes"] }).skills.map((item) => item.id)).toEqual(["vault:notes"]);
		expect(service.statusOf(service.get("built-in:mermaid-diagrams")!)).toBe("built-in");
	});

	test("a skill saved by AskMate's own editor can be trusted at save with computeHash", async () => {
		const host = new FakeHost();
		const text = skillText("made-here");
		host.files.set(`${FOLDER}/made-here/SKILL.md`, text);
		const { service } = await started(host);
		await service.trust("vault:made-here", await service.computeHash(text));
		expect(service.statusOf(service.get("vault:made-here")!)).toBe("ready");
	});

	test("editing an approved skill by one character returns it to needs-review after the next scan", async () => {
		const host = new FakeHost();
		const path = `${FOLDER}/notes/SKILL.md`;
		host.files.set(path, skillText("notes"));
		const { service } = await started(host);
		const approved = service.get("vault:notes")!;
		await service.trust(approved.id, approved.hash);
		expect(service.resolve({ request: "x", explicit: ["notes"] }).skills).toHaveLength(1);

		host.files.set(path, skillText("notes", "# Goal\nDo the thing!"));
		await service.scan();
		const edited = service.get("vault:notes")!;
		expect(edited.hash).not.toBe(approved.hash);
		expect(service.statusOf(edited)).toBe("needs-review");
		expect(service.resolve({ request: "x", explicit: ["notes"] }).skills).toEqual([]);
	});

	test("trusting a built-in or an unknown skill changes nothing, and a malformed hash is refused", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		const { service } = await started(host);
		await service.trust("built-in:mermaid-diagrams", "a".repeat(64));
		await service.trust("vault:missing", "a".repeat(64));
		expect(host.trusted).toEqual({});
		await expect(service.trust("vault:notes", "not-a-hash")).rejects.toThrow("SHA-256");
		expect(host.trusted).toEqual({});
	});

	test("a file that failed to parse cannot be approved", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/broken.md`, "no frontmatter at all");
		const { service } = await started(host);
		const broken = service.list().find((skill) => !skill.valid)!;
		await service.trust(broken.id, "a".repeat(64));
		expect(host.trusted).toEqual({});
	});

	test("find accepts an id or a plain name and ignores files that failed to parse", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		host.files.set(`${FOLDER}/broken.md`, "no frontmatter at all");
		const { service } = await started(host);
		expect(service.find("notes")?.id).toBe("vault:notes");
		expect(service.find("vault:notes")?.id).toBe("vault:notes");
		expect(service.find("Mermaid Diagrams")?.id).toBe("built-in:mermaid-diagrams");
		expect(service.find("broken")).toBeNull();
		expect(service.get("vault:notes")).not.toBeNull();
		expect(service.get("notes")).toBeNull();
	});

	test("revoking an approval puts the skill back in needs-review", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		const { service } = await started(host);
		const skill = service.get("vault:notes")!;
		await service.trust(skill.id, skill.hash);
		await service.revoke(skill.id);
		expect(service.statusOf(skill)).toBe("needs-review");
	});

	test("a disabled skill reports disabled and is not resolved", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		const { service } = await started(host);
		const skill = service.get("vault:notes")!;
		await service.trust(skill.id, skill.hash);
		host.config.disabledIds = ["vault:notes"];
		expect(service.statusOf(skill)).toBe("disabled");
		expect(service.resolve({ request: "x", explicit: ["notes"] }).notices[0]?.kind).toBe("disabled");
	});

	test("a deleted file disappears on the next scan and a sticky reference degrades to a notice", async () => {
		const host = new FakeHost();
		const path = `${FOLDER}/notes/SKILL.md`;
		host.files.set(path, skillText("notes"));
		const { service } = await started(host);
		const skill = service.get("vault:notes")!;
		await service.trust(skill.id, skill.hash);
		host.files.delete(path);
		await service.scan();
		expect(service.get("vault:notes")).toBeNull();
		const result = service.resolve({ request: "x", sticky: ["vault:notes"] });
		expect(result.skills).toEqual([]);
		expect(result.notices[0]).toMatchObject({ kind: "missing", activation: "sticky" });
	});

	test("a vault skill cannot take a built-in name, and duplicates are listed as invalid", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/mermaid-diagrams/SKILL.md`, skillText("mermaid-diagrams", "# Goal\nImpostor."));
		host.files.set(`${FOLDER}/a/SKILL.md`, skillText("twin"));
		host.files.set(`${FOLDER}/b/SKILL.md`, skillText("twin"));
		const { service } = await started(host);
		const byPath = (path: string) => service.list().find((skill) => skill.path === path);
		expect(byPath(`${FOLDER}/mermaid-diagrams/SKILL.md`)?.valid).toBe(false);
		expect(byPath(`${FOLDER}/a/SKILL.md`)?.valid).toBe(true);
		expect(byPath(`${FOLDER}/b/SKILL.md`)?.valid).toBe(false);
		expect(service.get("built-in:mermaid-diagrams")?.body).not.toContain("Impostor");
	});

	test("an unreadable file is listed as invalid with a reason, and the others still load", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/bad.md`, skillText("bad"));
		host.files.set(`${FOLDER}/good.md`, skillText("good"));
		host.failReading.add(`${FOLDER}/bad.md`);
		const { service } = await started(host);
		const bad = service.list().find((skill) => skill.path === `${FOLDER}/bad.md`);
		expect(bad).toMatchObject({ valid: false });
		expect(bad?.diagnostics.map((item) => item.code)).toEqual(["read-failed"]);
		expect(service.get("vault:good")?.valid).toBe(true);
		expect(host.warnings.length).toBeGreaterThan(0);
	});

	test("a file over 64 KB is listed as invalid and never read", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/huge.md`, skillText("huge"));
		host.sizeOverrides.set(`${FOLDER}/huge.md`, MAX_SKILL_FILE_BYTES + 1);
		const { service } = await started(host);
		const huge = service.list().find((skill) => skill.path === `${FOLDER}/huge.md`);
		expect(huge?.valid).toBe(false);
		expect(huge?.diagnostics.map((item) => item.code)).toEqual(["file-too-large"]);
		expect(host.readCalls).toEqual([]);
	});

	test("companion files are listed on the skill as ignored", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/tool/SKILL.md`, skillText("tool"));
		host.files.set(`${FOLDER}/tool/scripts/run.sh`, "echo hi");
		const { service } = await started(host);
		expect(service.get("vault:tool")?.ignored).toEqual(["scripts/run.sh"]);
		expect(host.readCalls).toEqual([`${FOLDER}/tool/SKILL.md`]);
	});

	test("an unusable folder setting falls back to the default and says so", async () => {
		const host = new FakeHost();
		host.config.folder = ".hidden/skills";
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		const { service } = await started(host);
		expect(service.issues().map((issue) => issue.code)).toEqual(["bad-folder"]);
		expect(service.get("vault:notes")).not.toBeNull();
	});

	test("turning skills off keeps only the built-ins and resolves nothing", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		host.config.enabled = false;
		const { service } = await started(host);
		expect(service.list().map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams"]);
		expect(service.resolve({ request: "turn this note into a flowchart" })).toEqual({ skills: [], notices: [], suggestion: null, totalCharacters: 0 });
	});

	test("unchanged files are not hashed again on a rescan", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/a.md`, skillText("a"));
		host.files.set(`${FOLDER}/b.md`, skillText("b"));
		const { service } = await started(host);
		const after = host.hashCalls;
		await service.scan();
		expect(host.hashCalls).toBe(after);
		host.files.set(`${FOLDER}/b.md`, skillText("b", "# Goal\nChanged."));
		await service.scan();
		expect(host.hashCalls).toBe(after + 1);
	});

	test("an explicit undefined from a caller falls back on the saved trust record instead of dropping it", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/notes/SKILL.md`, skillText("notes"));
		const { service } = await started(host);
		const skill = service.get("vault:notes")!;
		await service.trust(skill.id, skill.hash);
		const result = service.resolve({ request: "x", explicit: ["notes"], trusted: undefined, skills: undefined, matchMode: undefined, disabledIds: undefined, enabled: undefined });
		expect(result.skills.map((item) => item.id)).toEqual(["vault:notes"]);
	});

	test("a settings read that throws is reported and never rejects the scan", async () => {
		const host = new FakeHost();
		const service = new SkillService(host);
		host.getConfig = () => {
			throw new Error("settings unavailable");
		};
		await expect(service.scan()).resolves.toBeUndefined();
		expect(host.warnings).toContain("Reading skills failed.");
	});

	test("the built-in skill answers a matching request out of the box", async () => {
		const { service } = await started();
		const result = service.resolve({ request: "turn this note into a flowchart" });
		expect(result.skills.map((skill) => [skill.id, skill.activation])).toEqual([["built-in:mermaid-diagrams", "auto"]]);
	});

	test("the suggest setting offers the built-in as a chip and starts nothing", async () => {
		const host = new FakeHost();
		host.config = { ...host.config, matchMode: "suggest" };
		const { service } = await started(host);
		const result = service.resolve({ request: "turn this note into a flowchart" });
		expect(result.skills).toEqual([]);
		expect(result.suggestion).toMatchObject({ id: "built-in:mermaid-diagrams" });
	});
});

describe("SkillService refresh", () => {
	test("vault events inside the folder schedule one debounced rescan, however many arrive", async () => {
		const host = new FakeHost();
		const { service } = await started(host);
		const listed = host.listCalls;
		host.files.set(`${FOLDER}/new.md`, skillText("fresh"));
		host.emit(`${FOLDER}/new.md`);
		host.emit(`${FOLDER}/new.md`);
		host.emit(`${FOLDER}/other.md`);
		expect(host.pendingTimers).toBe(1);
		expect(host.lastTimerDelay).toBe(SKILL_RESCAN_DEBOUNCE_MS);
		expect(service.get("vault:fresh")).toBeNull();
		await host.runTimers();
		await settle();
		expect(host.listCalls).toBe(listed + 1);
		expect(service.get("vault:fresh")).not.toBeNull();
	});

	test("events outside the folder are ignored", async () => {
		const host = new FakeHost();
		await started(host);
		host.emit("Journal/today.md");
		host.emit("AskMate/SkillsBackup/a.md");
		expect(host.pendingTimers).toBe(0);
	});

	test("the folder is read from settings at event time, so changing it takes effect", async () => {
		const host = new FakeHost();
		await started(host);
		host.config.folder = "My Skills";
		host.emit("My Skills/x.md");
		expect(host.pendingTimers).toBe(1);
	});

	test("overlapping scans share one follow-up pass", async () => {
		const host = new FakeHost();
		let release: () => void = () => undefined;
		host.listDelay = new Promise<void>((resolve) => {
			release = resolve;
		});
		const service = new SkillService(host);
		const first = service.scan();
		const second = service.scan();
		const third = service.scan();
		release();
		await Promise.all([first, second, third]);
		expect(host.listCalls).toBe(2);
	});

	test("listeners hear about a real change once, not about an identical rescan", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/a.md`, skillText("a"));
		const service = new SkillService(host);
		let heard = 0;
		const stop = service.onChange(() => {
			heard += 1;
		});
		await service.scan();
		expect(heard).toBe(1);
		await service.scan();
		expect(heard).toBe(1);
		host.files.set(`${FOLDER}/b.md`, skillText("b"));
		await service.scan();
		expect(heard).toBe(2);
		stop();
		host.files.delete(`${FOLDER}/b.md`);
		await service.scan();
		expect(heard).toBe(2);
	});

	test("trusting or revoking notifies listeners", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/a.md`, skillText("a"));
		const { service } = await started(host);
		let heard = 0;
		service.onChange(() => {
			heard += 1;
		});
		const skill = service.get("vault:a")!;
		await service.trust(skill.id, skill.hash);
		await service.revoke(skill.id);
		expect(heard).toBe(2);
	});

	test("a listener that throws does not stop the others", async () => {
		const host = new FakeHost();
		const service = new SkillService(host);
		let heard = 0;
		service.onChange(() => {
			throw new Error("boom");
		});
		service.onChange(() => {
			heard += 1;
		});
		await service.scan();
		expect(heard).toBe(1);
		expect(host.warnings).toContain("A skills change listener failed.");
	});

	test("a failed folder listing keeps the skills already known instead of wiping them", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/a.md`, skillText("a"));
		const { service } = await started(host);
		host.failListing = true;
		await service.scan();
		expect(service.get("vault:a")).not.toBeNull();
		expect(host.warnings).toContain("Listing the skills folder failed.");
	});

	test("a failed listing on the very first scan still gives the built-in skill", async () => {
		const host = new FakeHost();
		host.failListing = true;
		const { service } = await started(host);
		expect(service.list().map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams"]);
		expect(service.isReady()).toBe(true);
	});

	test("watching starts on the first scan only, and dispose stops it and cancels a pending rescan", async () => {
		const host = new FakeHost();
		const service = new SkillService(host);
		expect(host.watcherCount).toBe(0);
		await service.scan();
		await service.scan();
		expect(host.watcherCount).toBe(1);
		host.emit(`${FOLDER}/a.md`);
		expect(host.pendingTimers).toBe(1);
		service.dispose();
		expect(host.pendingTimers).toBe(0);
		expect(host.watcherCount).toBe(0);
	});

	test("a scan queued behind a running scan does not start watching again after dispose", async () => {
		const host = new FakeHost();
		let release: () => void = () => undefined;
		host.listDelay = new Promise<void>((resolve) => {
			release = resolve;
		});
		const service = new SkillService(host);
		const first = service.scan();
		const second = service.scan();
		expect(host.watcherCount).toBe(1);
		service.dispose();
		expect(host.watcherCount).toBe(0);
		release();
		await Promise.all([first, second]);
		expect(host.watcherCount).toBe(0);
		expect(host.watchCalls).toBe(1);
		expect(host.listCalls).toBe(1);
	});

	test("after dispose, scan resolves without reading, watching or notifying, and a late event does nothing", async () => {
		const { host, service } = await started();
		let heard = 0;
		service.onChange(() => {
			heard += 1;
		});
		const listed = host.listCalls;
		service.dispose();
		host.files.set(`${FOLDER}/late.md`, skillText("late"));
		await service.scan();
		host.emit(`${FOLDER}/late.md`);
		await host.runTimers();
		await settle();
		expect(host.listCalls).toBe(listed);
		expect(host.watcherCount).toBe(0);
		expect(host.pendingTimers).toBe(0);
		expect(heard).toBe(0);
		expect(service.list().map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams"]);
	});

	test("a rescan timer that fires after dispose does not scan", async () => {
		const { host, service } = await started();
		host.emit(`${FOLDER}/a.md`);
		const listed = host.listCalls;
		const pending = host.takeTimers();
		service.dispose();
		for (const callback of pending) {
			callback();
		}
		await settle();
		expect(host.listCalls).toBe(listed);
		expect(host.watcherCount).toBe(0);
	});

	test("dispose can be called twice", async () => {
		const { service } = await started();
		service.dispose();
		expect(() => service.dispose()).not.toThrow();
	});

	test("a host whose watch throws is reported and the scan still completes with the catalogue", async () => {
		const host = new FakeHost();
		host.watchError = new Error("boom");
		host.files.set(`${FOLDER}/a.md`, skillText("a"));
		const service = new SkillService(host);
		let pending: Promise<void> | undefined;
		expect(() => {
			pending = service.scan();
		}).not.toThrow();
		await expect(pending).resolves.toBeUndefined();
		expect(host.warnings).toContain("Watching the skills folder failed.");
		expect(service.isReady()).toBe(true);
		expect(service.list().map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams", "vault:a"]);
	});

	test("watching is attempted again on the next scan once the host recovers", async () => {
		const host = new FakeHost();
		host.watchError = new Error("boom");
		const service = new SkillService(host);
		await service.scan();
		expect(host.watcherCount).toBe(0);
		host.watchError = null;
		await service.scan();
		expect(host.watcherCount).toBe(1);
		host.emit(`${FOLDER}/a.md`);
		expect(host.pendingTimers).toBe(1);
	});

	test("uses the injected parser and hash, never a global one", async () => {
		const host = new FakeHost();
		host.files.set(`${FOLDER}/a.md`, skillText("a"));
		await started(host);
		expect(host.parsed).toBeGreaterThanOrEqual(2);
		expect(host.hashCalls).toBeGreaterThanOrEqual(2);
	});
});

describe("skills module boundaries", () => {
	function sourceFiles(directory: string): string[] {
		return readdirSync(directory).flatMap((entry) => {
			const path = join(directory, entry);
			return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
		});
	}

	test("nothing in src/skills imports obsidian or any other module outside the folder, and no dependency was added", () => {
		const imports: string[] = [];
		for (const path of sourceFiles("src/skills")) {
			for (const match of readFileSync(path, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
				imports.push(match[1] ?? "");
			}
		}
		expect(imports.length).toBeGreaterThan(10);
		expect(imports.filter((specifier) => !specifier.startsWith("."))).toEqual([]);
		expect(imports.filter((specifier) => specifier.startsWith("../") && !specifier.startsWith("../limits") && !specifier.startsWith("../parse") && !specifier.startsWith("../render") && !specifier.startsWith("../trust") && !specifier.startsWith("../types") && !specifier.startsWith("../frontmatter"))).toEqual([]);
	});

	test("the skills code never calls console, eval, innerHTML or network APIs", () => {
		for (const path of sourceFiles("src/skills")) {
			const text = readFileSync(path, "utf8");
			expect({ path, found: /console\.|\beval\(|innerHTML|\bfetch\(|requestUrl|XMLHttpRequest|child_process/.test(text) }).toEqual({ path, found: false });
		}
	});
});
