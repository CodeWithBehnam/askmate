import type { AskMateSettings } from "../shared/types";
import {
	createEmptyThreadStore,
	deleteThreadFromStore,
	findThread,
	listThreadsByRecency,
	normalizeThreadStore,
	renameThreadInStore,
	setActiveThread,
	upsertThread,
	type SavedThread,
	type ThreadStore
} from "./threadModel";

export const THREAD_SAVE_DEBOUNCE_MS = 1000;

export type ThreadServiceHost = {
	getSettings: () => AskMateSettings;
	saveSettings: () => Promise<void>;
	/** Injected so tests can drive the debounce without real time. */
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	warn?: (message: string, error: unknown) => void;
};

/**
 * Shell around the pure thread model: debounces writes and persists into plugin data, the way HistoryService does.
 * Nothing is read or written while "Save conversations" is off.
 */
export class ThreadService {
	private pending: SavedThread | null = null;
	private timer: unknown = null;
	private saveChain: Promise<void> = Promise.resolve();

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
		this.pending = thread;
		this.cancelTimer();
		const setTimer = this.host.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
		this.timer = setTimer(() => {
			this.timer = null;
			void this.flush();
		}, THREAD_SAVE_DEBOUNCE_MS);
	}

	/** Writes any queued thread now. Call it before switching threads and when the view or plugin closes. */
	async flush(): Promise<void> {
		this.cancelTimer();
		const thread = this.pending;
		this.pending = null;
		if (!thread || !this.isEnabled()) {
			return;
		}
		await this.persist((store) => upsertThread(store, thread));
	}

	async markActive(id: string | null): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}
		await this.persist((store) => setActiveThread(store, id));
	}

	async rename(id: string, title: string): Promise<void> {
		await this.persist((store) => renameThreadInStore(store, id, title));
	}

	async remove(id: string): Promise<void> {
		if (this.pending?.id === id) {
			this.pending = null;
			this.cancelTimer();
		}
		await this.persist((store) => deleteThreadFromStore(store, id));
	}

	async clearAll(): Promise<void> {
		this.pending = null;
		this.cancelTimer();
		await this.persist(() => createEmptyThreadStore());
	}

	private readStore(): ThreadStore {
		return normalizeThreadStore(this.host.getSettings().threadStore);
	}

	private async persist(update: (store: ThreadStore) => ThreadStore): Promise<void> {
		const settings = this.host.getSettings();
		const previous = settings.threadStore;
		settings.threadStore = normalizeThreadStore(update(this.readStore()));
		// Writes run one after another so a slow save can never land after a newer one.
		const run = this.saveChain.then(async () => {
			try {
				await this.host.saveSettings();
			} catch (error) {
				settings.threadStore = previous;
				(this.host.warn ?? ((message, cause) => console.warn(message, cause)))("AskMate could not save conversations.", error);
			}
		});
		this.saveChain = run;
		await run;
	}

	private cancelTimer(): void {
		if (this.timer !== null) {
			const clearTimer = this.host.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
			clearTimer(this.timer);
			this.timer = null;
		}
	}
}
