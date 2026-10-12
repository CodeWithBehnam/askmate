import type { AskMateSettings } from "../shared/types";
import {
	applyPathChangeToStore,
	applyPathChangeToThread,
	createEmptyThreadStore,
	deleteThreadFromStore,
	findThread,
	isSameThreadStore,
	listThreadsByRecency,
	normalizeThreadStore,
	renameThreadInStore,
	setActiveThread,
	upsertThread,
	type SavedThread,
	type ThreadPathChange,
	type ThreadStore
} from "./threadModel";

export const THREAD_SAVE_DEBOUNCE_MS = 1000;
/** A failing disk would otherwise raise a warning with every save. */
export const THREAD_SAVE_WARNING_INTERVAL_MS = 60_000;
export const THREAD_SAVE_FAILED_MESSAGE = "AskMate could not save conversations. Recent changes may be lost if Obsidian closes.";

export type ThreadServiceHost = {
	getSettings: () => AskMateSettings;
	saveSettings: () => Promise<void>;
	/** Injected so tests can drive the debounce without real time. */
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Diagnostics for every failed write. Defaults to console.warn. */
	warn?: (message: string, error: unknown) => void;
	/** User-facing warning (for example a Notice), raised at most once per THREAD_SAVE_WARNING_INTERVAL_MS. */
	notify?: (message: string) => void;
	/** Milliseconds since the epoch; injected so tests can drive the warning throttle. */
	now?: () => number;
};

/**
 * Shell around the pure thread model: debounces writes and persists into plugin data.
 * Nothing is saved while "Save conversations" is off. Every store change goes through one serialised chain, and
 * each step snapshots and, on a failed write, reverts only its own change.
 */
export class ThreadService {
	/** Threads waiting for the debounce, by id, in the order they were last scheduled. */
	private readonly pending = new Map<string, SavedThread>();
	private timer: unknown = null;
	private saveChain: Promise<void> = Promise.resolve();
	/** Bumped by reload so writes prepared against older data are dropped. */
	private generation = 0;
	private lastWarningAt: number | null = null;
	private readonly clearListeners = new Set<() => void>();
	private readonly rewriteListeners = new Set<(change: ThreadPathChange) => void>();

	constructor(private readonly host: ThreadServiceHost) {}

	isEnabled(): boolean {
		return this.host.getSettings().saveConversations;
	}

	/** The thread that was active when the sidebar was last used, or null when none is stored. */
	getActiveThread(): SavedThread | null {
		if (!this.isEnabled()) {
			return null;
		}
		const store = this.readStore();
		return findThread(store, store.activeId);
	}

	getThread(id: string): SavedThread | null {
		return findThread(this.readStore(), id);
	}

	listThreads(): SavedThread[] {
		return listThreadsByRecency(this.readStore());
	}

	/** Queues a save. Rapid calls collapse into one write after the debounce delay. */
	scheduleSave(thread: SavedThread): void {
		if (!this.isEnabled()) {
			return;
		}
		// Deleting first moves the thread to the end, so the most recently scheduled one ends up active.
		this.pending.delete(thread.id);
		this.pending.set(thread.id, thread);
		this.cancelTimer();
		const setTimer = this.host.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
		this.timer = setTimer(() => {
			this.timer = null;
			void this.flush();
		}, THREAD_SAVE_DEBOUNCE_MS);
	}

	/**
	 * Saves the thread now and resolves once the write has finished. True when the thread is stored, or when saving
	 * is off (nothing was asked of the disk); false when the write failed or was superseded by a reload.
	 */
	async saveNow(thread: SavedThread): Promise<boolean> {
		if (!this.isEnabled()) {
			return true;
		}
		this.pending.delete(thread.id);
		this.pending.set(thread.id, thread);
		return await this.flush();
	}

	/**
	 * Writes every queued thread now. Call it before switching threads and when the view or plugin closes.
	 * With nothing queued it still waits for writes already under way.
	 */
	async flush(): Promise<boolean> {
		this.cancelTimer();
		const threads = [...this.pending.values()];
		this.pending.clear();
		if (threads.length === 0) {
			await this.saveChain;
			return true;
		}
		if (!this.isEnabled()) {
			return true;
		}
		return await this.persist((store) => threads.reduce((next, thread) => upsertThread(next, thread), store), this.generation);
	}

	async markActive(id: string | null): Promise<boolean> {
		if (!this.isEnabled()) {
			return true;
		}
		return await this.persist((store) => setActiveThread(store, id));
	}

	async rename(id: string, title: string): Promise<boolean> {
		return await this.persist((store) => renameThreadInStore(store, id, title));
	}

	async remove(id: string): Promise<boolean> {
		this.pending.delete(id);
		if (this.pending.size === 0) {
			this.cancelTimer();
		}
		return await this.persist((store) => deleteThreadFromStore(store, id));
	}

	/** Deletes every saved conversation. Subscribers of onDidClear are told once the store is empty on disk. */
	async clearAll(): Promise<boolean> {
		this.pending.clear();
		this.cancelTimer();
		const cleared = await this.persist(() => createEmptyThreadStore());
		if (cleared) {
			this.notifyCleared();
		}
		return cleared;
	}

	/** Subscribes to clearAll, so an open sidebar can drop the conversation it still shows. Returns the unsubscribe function. */
	onDidClear(callback: () => void): () => void {
		this.clearListeners.add(callback);
		return () => {
			this.clearListeners.delete(callback);
		};
	}

	/**
	 * The stored threads were replaced from outside (for example a sync brought a newer data file): adopt them and
	 * drop every write that was prepared against the old data, so it cannot overwrite them.
	 */
	reload(store: unknown): void {
		this.generation += 1;
		this.cancelTimer();
		this.pending.clear();
		this.host.getSettings().threadStore = normalizeThreadStore(store);
	}

	/**
	 * Subscribes to rename and delete rewrites. The sidebar keeps its own transcript and its next save replaces the whole
	 * stored thread, so it must apply the same change to that transcript (applyPathChangeToLiveMessages) or the old
	 * paths and the deleted note's quotes come back. Callbacks run synchronously, before the queued saves and the
	 * store are rewritten and before the first await, so any snapshot taken after a callback returns already carries
	 * the new paths. They are not called for a change that moves nothing. Returns the unsubscribe function.
	 */
	onDidRewritePaths(callback: (change: ThreadPathChange) => void): () => void {
		this.rewriteListeners.add(callback);
		return () => {
			this.rewriteListeners.delete(callback);
		};
	}

	/**
	 * A note or folder was renamed: moves sourcePath and imagePath in saved and queued threads and tells the
	 * onDidRewritePaths subscribers. Works while saving is off.
	 */
	async handleFileRenamed(oldPath: string, newPath: string): Promise<void> {
		if (!oldPath || oldPath === newPath) {
			return;
		}
		await this.rewritePaths({ kind: "renamed", oldPath, newPath });
	}

	/**
	 * A note or folder was deleted: forgets the links to it and the replies that quote it; the conversations stay.
	 * Tells the onDidRewritePaths subscribers.
	 */
	async handleFileDeleted(path: string): Promise<void> {
		if (!path) {
			return;
		}
		await this.rewritePaths({ kind: "deleted", path });
	}

	private async rewritePaths(change: ThreadPathChange): Promise<void> {
		this.notifyRewritten(change);
		for (const [id, thread] of this.pending) {
			this.pending.set(id, applyPathChangeToThread(thread, change));
		}
		await this.persist((store) => applyPathChangeToStore(store, change));
	}

	private readStore(): ThreadStore {
		return normalizeThreadStore(this.host.getSettings().threadStore);
	}

	/** Resolves true when the change is on disk (or there was nothing to write), false when it was not. Never rejects on a failed write. */
	private persist(update: (store: ThreadStore) => ThreadStore, expectedGeneration?: number): Promise<boolean> {
		// Writes run one after another so a slow save can never land after a newer one.
		const run = this.saveChain.then(() => this.writeStore(update, expectedGeneration));
		this.saveChain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async writeStore(update: (store: ThreadStore) => ThreadStore, expectedGeneration: number | undefined): Promise<boolean> {
		if (expectedGeneration !== undefined && expectedGeneration !== this.generation) {
			return false;
		}
		const settings = this.host.getSettings();
		const previous = settings.threadStore;
		const next = normalizeThreadStore(update(normalizeThreadStore(previous)));
		if (isSameThreadStore(previous, next)) {
			return true;
		}
		settings.threadStore = next;
		try {
			await this.host.saveSettings();
			return true;
		} catch (error) {
			// Only undo this step's own change: a reload may have replaced the store while the write was running.
			if (settings.threadStore === next) {
				settings.threadStore = previous;
			}
			this.reportSaveFailure(error);
			return false;
		}
	}

	private reportSaveFailure(error: unknown): void {
		(this.host.warn ?? ((message, cause) => console.warn(message, cause)))(THREAD_SAVE_FAILED_MESSAGE, error);
		if (!this.host.notify) {
			return;
		}
		const now = (this.host.now ?? Date.now)();
		if (this.lastWarningAt === null || now - this.lastWarningAt >= THREAD_SAVE_WARNING_INTERVAL_MS) {
			this.lastWarningAt = now;
			this.host.notify(THREAD_SAVE_FAILED_MESSAGE);
		}
	}

	private notifyCleared(): void {
		for (const listener of [...this.clearListeners]) {
			this.runListener(() => listener());
		}
	}

	private notifyRewritten(change: ThreadPathChange): void {
		for (const listener of [...this.rewriteListeners]) {
			this.runListener(() => listener(change));
		}
	}

	/** One failing subscriber must not stop the others or the write. */
	private runListener(run: () => void): void {
		try {
			run();
		} catch (error) {
			(this.host.warn ?? ((message, cause) => console.warn(message, cause)))("An AskMate conversation listener failed.", error);
		}
	}

	private cancelTimer(): void {
		if (this.timer !== null) {
			const clearTimer = this.host.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
			clearTimer(this.timer);
			this.timer = null;
		}
	}
}
