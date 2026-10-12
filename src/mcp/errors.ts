import { type JsonValue, McpClientError, isJsonObject } from "./protocol";
import { redactMcpText } from "./redact";

/** User-facing wording for every McpClientError kind. Raw stack traces never reach the UI. */
export interface McpErrorCopy {
	/** One sentence the user can act on. */
	readonly message: string;
	/** The specific cause, redacted. Show it collapsed. */
	readonly detail: string;
	/** A short suggested action, or null when retrying will not help. */
	readonly fix: string | null;
}

const TIMEOUT_MESSAGE = "The server did not answer in time. The first run of an npx or uvx server can download packages, so try again or raise the timeout in this server's settings.";
const AUTH_MESSAGE = "This server needs a token. Add or replace it in the server settings.";
const INPUT_MESSAGE = "This tool needs an extra step that AskMate does not support yet.";
const RETIRED_SSE_MESSAGE = "This server uses the retired HTTP+SSE transport. Ask its author to enable Streamable HTTP, or run it through a stdio bridge.";

function scopeHint(detail: JsonValue | undefined): string {
	if (!isJsonObject(detail) || typeof detail.wwwAuthenticate !== "string") {
		return "";
	}
	const scope = /scope="([^"]{1,200})"/i.exec(detail.wwwAuthenticate);
	return scope?.[1] ? ` It asked for the scope "${scope[1]}".` : "";
}

export function describeMcpError(error: McpClientError, secrets: readonly string[] = []): McpErrorCopy {
	const detail = redactMcpText(error.message, secrets);
	switch (error.kind) {
		case "timeout":
			return { message: TIMEOUT_MESSAGE, detail, fix: "Try again, or raise the timeout in this server's settings." };
		case "aborted":
			return { message: "Stopped.", detail, fix: null };
		case "transport":
			return {
				message: `The connection failed. ${detail}`.trim(),
				detail,
				fix: /ENOENT/.test(detail)
					? "Check that the command is installed and on your PATH, or use its full path."
					: "Restart the server from its settings."
			};
		case "auth_required":
			return { message: `${AUTH_MESSAGE}${scopeHint(error.detail)}`, detail, fix: "Add or replace the token." };
		case "input_required":
			return { message: INPUT_MESSAGE, detail, fix: null };
		case "unsupported":
			return /HTTP\+SSE/.test(detail)
				? { message: RETIRED_SSE_MESSAGE, detail, fix: "Ask the server author for Streamable HTTP." }
				: { message: detail, detail, fix: "Change the server settings." };
		case "protocol":
		case "server_error":
			return { message: `The server reported a problem: ${detail}`, detail, fix: null };
	}
}
