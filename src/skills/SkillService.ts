import { loadBuiltInSkills } from "./builtin";
import type { YamlParser } from "./frontmatter";
import { SKILL_RESCAN_DEBOUNCE_MS } from "./limits";
import { parseSkillFile } from "./parse";
import { findSkill, resolveSkills } from "./resolve";
import { assembleCatalogue, isInSkillsFolder, normaliseSkillsFolder, planSkillScan, type ScanCandidate, type SkillFileInfo } from "./scan";
import { hashSkillText, isValidHash, sha256Hex, skillStatus, type Sha256 } from "./trust";
import type { Diagnostic, ResolveInput, Skill, SkillMatchMode, SkillResolution, SkillStatus } from "./types";

/** Settings the service reads each time it needs them, so a change in the settings tab takes effect without a restart. */
export interface SkillConfig {
	enabled: boolean;
	folder: string;
	matchMode: SkillMatchMode;
	disabledIds: readonly string[];
	/** Skill id to the content hash the user approved. */
	trusted: Readonly<Record<string, string>>;
}

/**
 * Everything the service needs from the outside. There is no import from obsidian here: the plugin passes
 * vault.adapter, Obsidian's parseYaml and a vault event bridge, and tests pass fakes.
 */
export interface SkillHost {
	getConfig(): SkillConfig;
	/** Every file below the folder, recursively. A missing folder gives an empty list. */
	listFiles(folder: string): Promise<readonly SkillFileInfo[]>;
	readFile(path: string): Promise<string>;
	/** Obsidian's parseYaml. Must throw on invalid YAML. */
	parseYaml: YamlParser;
	/** Defaults to Web Crypto SHA-256. */
	sha256?: Sha256;
	/** Persists or, with null, removes the approved hash for a skill id, so that `getConfig().trusted` reflects it. */
	saveTrust(id: string, hash: string | null): Promise<void>;
	/**
	 * Raw vault events (create, modify, delete, rename) with the affected path; call it for both the old and the new
	 * path on a rename. The service filters them to the skills folder itself. Returns an unsubscribe function.
	 */
	watch(callback: (path: string) => void): () => void;
	setTimer?(callback: () => void, delayMs: number): unknown;
	clearTimer?(handle: unknown): void;
	warn?(message: string, error: unknown): void;
}

interface CachedFile {
	raw: string;
	fallbackName: string;
	ignoredKey: string;
	skill: Skill;
}

/**
 * Keeps the skill catalogue: built-ins plus the vault folder, refreshed when files change. All decisions (parsing,
 * trust, matching, limits) live in pure functions; this class only reads files, remembers the result and tells
 * listeners. Call `scan()` once the workspace is ready and before the first `resolve()`.
 */
export class SkillService {
	private catalogue: readonly Skill[] = [];
	private folderIssues: readonly Diagnostic[] = [];
	private builtIns: Skill[] | null = null;
	private readonly cache = new Map<string, CachedFile>();
	private readonly listeners = new Set<() => void>();
	private current: Promise<void> | null = null;
	private queued: Promise<void> | null = null;
	private stopWatching: (() => void) | null = null;
	private rescanTimer: unknown = null;
	private signature = "";
	private scanned = false;
	private disposed = false;

	constructor(private readonly host: SkillHost) {}

	// Arrow wrappers keep a class-based host's `this` when the functions are handed to the pure parser.
	private readonly parseYaml: YamlParser = (text) => this.host.parseYaml(text);
	private readonly sha256: Sha256 = (text) => (this.host.sha256 ? this.host.sha256(text) : sha256Hex(text));

	/** True once the first scan has finished. */
	isReady(): boolean {
		return this.scanned;
	}

	list(): readonly Skill[] {
		return this.catalogue;
	}

	/** Problems with the folder itself, such as an unusable path or too many files. */
	issues(): readonly Diagnostic[] {
		return this.folderIssues;
	}

	/** Exact lookup by id, including files that failed to parse. */
	get(id: string): Skill | null {
		return this.catalogue.find((skill) => skill.id === id) ?? null;
	}

	/** Lookup by id or plain name, as a slash command or @skill mention would write it. Valid skills only. */
	find(ref: string): Skill | null {
		return findSkill(this.catalogue, ref).skill;
	}

	statusOf(skill: Skill): SkillStatus {
		const config = this.host.getConfig();
		return skillStatus(skill, config.trusted, config.disabledIds);
	}

	resolve(input: ResolveInput): SkillResolution {
		const config = this.host.getConfig();
		// Each field falls back on its own, so an explicit undefined from a caller can never drop the trust record.
		return resolveSkills({
			...input,
			skills: input.skills ?? this.catalogue,
			trusted: input.trusted ?? config.trusted,
			disabledIds: input.disabledIds ?? config.disabledIds,
			matchMode: input.matchMode ?? config.matchMode,
			enabled: input.enabled ?? config.enabled
		});
	}

	/** The hash a trust record must hold for this text. Use it with `trust` after saving a skill from the editor. */
	computeHash(raw: string): Promise<string> {
		return hashSkillText(raw, this.sha256);
	}

	/** Records that the user approved the skill with this exact content hash. Built-in skills need no approval. */
	async trust(id: string, hash: string): Promise<void> {
		const skill = this.get(id);
		if (!skill || !skill.valid || skill.source === "built-in") {
			return;
		}
		if (!isValidHash(hash)) {
			throw new Error("A skill approval needs a SHA-256 hash.");
		}
		await this.host.saveTrust(id, hash);
		this.notify();
	}

	async revoke(id: string): Promise<void> {
		await this.host.saveTrust(id, null);
		this.notify();
	}

	onChange(callback: () => void): () => void {
		this.listeners.add(callback);
		return () => {
			this.listeners.delete(callback);
		};
	}

	/**
	 * Reads the skills folder again. Calls made while a scan is running share one follow-up scan, so a burst of
	 * vault events never queues more than one extra pass. Never rejects or throws: problems become diagnostics or
	 * warnings through the host. Does nothing once the service is disposed.
	 */
	scan(): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.startWatching();
		if (!this.current) {
			this.current = this.runScan()
				.catch((error: unknown) => {
					this.host.warn?.("Reading skills failed.", error);
				})
				.finally(() => {
					this.current = null;
				});
			return this.current;
		}
		if (!this.queued) {
			this.queued = this.current.then(() => {
				this.queued = null;
				return this.scan();
			});
		}
		return this.queued;
	}

	/** Stops watching and ignores every later call to `scan`, including one that was already queued behind a running scan. */
	dispose(): void {
		this.disposed = true;
		this.stopWatching?.();
		this.stopWatching = null;
		this.cancelRescan();
		this.listeners.clear();
	}

	private startWatching(): void {
		if (this.stopWatching || this.disposed) {
			return;
		}
		try {
			this.stopWatching = this.host.watch((path) => {
				if (this.disposed) {
					return;
				}
				const { folder } = normaliseSkillsFolder(this.host.getConfig().folder);
				if (isInSkillsFolder(path, folder)) {
					this.scheduleRescan();
				}
			});
		} catch (error) {
			// The catalogue still works without live updates, so a host that cannot watch must not break scan().
			this.host.warn?.("Watching the skills folder failed.", error);
		}
	}

	private scheduleRescan(): void {
		if (this.disposed) {
			return;
		}
		this.cancelRescan();
		const run = (): void => {
			this.rescanTimer = null;
			if (!this.disposed) {
				void this.scan();
			}
		};
		// Called on the host object, not detached, so a class-based host keeps its `this`.
		this.rescanTimer = this.host.setTimer
			? this.host.setTimer(run, SKILL_RESCAN_DEBOUNCE_MS)
			: window.setTimeout(run, SKILL_RESCAN_DEBOUNCE_MS);
	}

	private cancelRescan(): void {
		if (this.rescanTimer === null) {
			return;
		}
		if (this.host.clearTimer) {
			this.host.clearTimer(this.rescanTimer);
		} else {
			window.clearTimeout(this.rescanTimer as number);
		}
		this.rescanTimer = null;
	}

	private notify(): void {
		for (const listener of Array.from(this.listeners)) {
			try {
				listener();
			} catch (error) {
				this.host.warn?.("A skills change listener failed.", error);
			}
		}
	}

	private async runScan(): Promise<void> {
		const config = this.host.getConfig();
		const sha256 = this.sha256;
		const issues: Diagnostic[] = [];
		try {
			this.builtIns ??= await loadBuiltInSkills(this.parseYaml, sha256);
			let vault: Skill[] = [];
			if (config.enabled) {
				const { folder, diagnostic } = normaliseSkillsFolder(config.folder);
				if (diagnostic) {
					issues.push(diagnostic);
				}
				const listing = await this.listSafely(folder);
				if (listing) {
					const plan = planSkillScan(listing, folder);
					issues.push(...plan.diagnostics);
					vault = await this.readCandidates(plan.candidates, sha256);
				} else {
					// Keep what was known: a failed listing says nothing about the skills themselves.
					vault = this.catalogue.filter((skill) => skill.source === "vault");
				}
			}
			this.catalogue = assembleCatalogue(this.builtIns, vault);
		} catch (error) {
			this.host.warn?.("Reading skills failed.", error);
		}
		this.folderIssues = issues;
		this.scanned = true;
		const next = this.signatureOf();
		if (next !== this.signature) {
			this.signature = next;
			this.notify();
		}
	}

	private async listSafely(folder: string): Promise<readonly SkillFileInfo[] | null> {
		try {
			return await this.host.listFiles(folder);
		} catch (error) {
			this.host.warn?.("Listing the skills folder failed.", error);
			return null;
		}
	}

	private async readCandidates(candidates: readonly ScanCandidate[], sha256: Sha256): Promise<Skill[]> {
		const skills: Skill[] = [];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			seen.add(candidate.path);
			skills.push(await this.readCandidate(candidate, sha256));
		}
		for (const path of Array.from(this.cache.keys())) {
			if (!seen.has(path)) {
				this.cache.delete(path);
			}
		}
		return skills;
	}

	private async readCandidate(candidate: ScanCandidate, sha256: Sha256): Promise<Skill> {
		const base = {
			path: candidate.path,
			source: "vault" as const,
			fallbackName: candidate.fallbackName,
			parseYaml: this.parseYaml,
			ignoredResources: candidate.ignoredResources
		};
		if (candidate.oversized) {
			return this.failedSkill(candidate, "file-too-large", "The file is larger than 64 KB, which is the limit for a skill.");
		}
		let raw: string;
		try {
			raw = await this.host.readFile(candidate.path);
		} catch (error) {
			this.host.warn?.(`Reading ${candidate.path} failed.`, error);
			return this.unreadableSkill(candidate);
		}
		const ignoredKey = candidate.ignoredResources.join("\n");
		const cached = this.cache.get(candidate.path);
		if (cached && cached.raw === raw && cached.fallbackName === candidate.fallbackName && cached.ignoredKey === ignoredKey) {
			return cached.skill;
		}
		const skill = parseSkillFile({ ...base, raw, hash: await hashSkillText(raw, sha256) });
		this.cache.set(candidate.path, { raw, fallbackName: candidate.fallbackName, ignoredKey, skill });
		return skill;
	}

	private unreadableSkill(candidate: ScanCandidate): Skill {
		return this.failedSkill(candidate, "read-failed", "The file could not be read.");
	}

	/** An entry for a file that was never parsed, so the list still shows it with the reason. */
	private failedSkill(candidate: ScanCandidate, code: "file-too-large" | "read-failed", message: string): Skill {
		const placeholder = parseSkillFile({
			path: candidate.path,
			raw: "",
			hash: "",
			source: "vault",
			fallbackName: candidate.fallbackName,
			parseYaml: this.parseYaml
		});
		return { ...placeholder, diagnostics: [{ level: "error", code, message }], raw: "" };
	}

	private signatureOf(): string {
		const skills = this.catalogue.map((skill) => `${skill.id}|${skill.hash}|${skill.valid ? 1 : 0}|${skill.diagnostics.length}`).join(";");
		return `${skills}#${this.folderIssues.map((issue) => issue.code).join(",")}`;
	}
}
