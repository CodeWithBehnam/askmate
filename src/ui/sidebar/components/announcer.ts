import { describeAnnouncement, type AnnouncementEvent } from "../announce";

/**
 * One status element for the whole sidebar. Assistive technology speaks a live region only when its text changes, so
 * saying the same sentence twice in a row (two replies that finish the same way) would be silent the second time.
 * The announcer alternates a trailing no-break space, which is not spoken, to make every call a change.
 */

export interface Announcer {
	announce(event: AnnouncementEvent): string;
	say(message: string): string;
	/** Empties the region without announcing anything. */
	clear(): void;
}

const NO_BREAK_SPACE = " ";

export function createAnnouncer(setText: (text: string) => void): Announcer {
	let alternate = false;
	let last = "";
	const say = (message: string): string => {
		alternate = message === last ? !alternate : false;
		last = message;
		const text = alternate ? `${message}${NO_BREAK_SPACE}` : message;
		setText(text);
		return text;
	};
	return {
		say,
		announce: (event) => say(describeAnnouncement(event)),
		clear() {
			alternate = false;
			last = "";
			setText("");
		}
	};
}
