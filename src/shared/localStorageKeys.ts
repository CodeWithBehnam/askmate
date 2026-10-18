/**
 * Keys AskMate keeps in Obsidian's local storage. It is per vault and per device and never synced, so it holds only what a
 * reload or crash would otherwise lose. API keys are never kept here.
 */

/** A question sent from the composer whose answer had not arrived. Only kept while Remember conversations is on. */
export const PENDING_QUESTION_KEY = "askmate-pending-question";

/** The Connect card's provider, address and model while setup is unfinished. Never the key. */
export const SETUP_DRAFT_KEY = "askmate-setup-draft";

/** The last connection test that failed because of a setting (key, model or address), for the same provider and address. */
export const FAILED_SETUP_TEST_KEY = "askmate-failed-setup-test";
