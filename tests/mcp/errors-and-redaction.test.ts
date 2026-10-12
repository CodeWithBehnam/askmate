import { describe, expect, test } from "bun:test";
import { describeMcpError } from "../../src/mcp/errors";
import { McpClientError } from "../../src/mcp/protocol";
import { redactMcpText, stripAuthScheme } from "../../src/mcp/redact";

describe("error wording", () => {
	test("each kind gets fixed, actionable wording", () => {
		expect(describeMcpError(new McpClientError("timeout", "The server did not answer within 30 seconds.")).message).toContain("first run of an npx or uvx server can download packages");
		expect(describeMcpError(new McpClientError("aborted", "Stopped.")).message).toBe("Stopped.");
		expect(describeMcpError(new McpClientError("input_required", "x")).message).toBe("This tool needs an extra step that AskMate does not support yet.");
		expect(describeMcpError(new McpClientError("unsupported", "This server uses the retired HTTP+SSE transport. Ask its author for Streamable HTTP, or run it through a stdio bridge.")).message).toContain("Ask its author to enable Streamable HTTP");
		expect(describeMcpError(new McpClientError("unsupported", "Use an https:// URL.")).message).toBe("Use an https:// URL.");
		expect(describeMcpError(new McpClientError("server_error", "The server reported an error (-32602): bad")).message).toContain("The server reported a problem");
		expect(describeMcpError(new McpClientError("protocol", "weird")).fix).toBeNull();
	});

	test("auth errors say a token is needed and repeat the scope the server asked for", () => {
		const copy = describeMcpError(new McpClientError("auth_required", "needs auth", { wwwAuthenticate: 'Bearer realm="x", scope="notes:read"' }));
		expect(copy.message).toContain("This server needs a token. Add or replace it in the server settings.");
		expect(copy.message).toContain('"notes:read"');
		expect(describeMcpError(new McpClientError("auth_required", "needs auth", { wwwAuthenticate: null })).message).not.toContain("scope");
		expect(describeMcpError(new McpClientError("auth_required", "needs auth")).message).not.toContain("scope");
	});

	test("transport errors carry the redacted cause and a fix that fits", () => {
		const missing = describeMcpError(new McpClientError("transport", "Could not start the server: spawn uvx ENOENT"));
		expect(missing.message).toContain("ENOENT");
		expect(missing.fix).toContain("PATH");
		const dropped = describeMcpError(new McpClientError("transport", "The server stopped (exit code 1). It said: token=abcdefghijklmnop"), ["abcdefghijklmnop"]);
		expect(dropped.message).not.toContain("abcdefghijklmnop");
		expect(dropped.detail).not.toContain("abcdefghijklmnop");
		expect(dropped.fix).toContain("Restart");
	});
});

describe("redaction", () => {
	test("bearer tokens, authorization headers and key-value credentials are masked", () => {
		expect(redactMcpText("Bearer abc.def-ghi_jkl")).toBe("Bearer [redacted]");
		expect(redactMcpText('{"Authorization": "Bearer short"}')).toBe('{"Authorization": "[redacted]"}');
		expect(redactMcpText("authorization: Basic dXNlcjpwYXNz")).toBe("authorization: [redacted]");
		expect(redactMcpText("x-api-key=abc123 ok")).toBe("x-api-key=[redacted] ok");
		expect(redactMcpText("password: hunter2, user: me")).toBe("password: [redacted], user: me");
		expect(redactMcpText("access_token=xyz&next=1")).toBe("access_token=[redacted]&next=1");
		expect(redactMcpText("failed for sk-abcdefghijklmnopqrstuvwxyz")).toBe("failed for [redacted]");
	});

	test("exact secrets are masked wherever they appear, and very short ones are left alone", () => {
		expect(redactMcpText("value=tok-123456 and tok-123456 again", ["tok-123456"])).toBe("value=[redacted] and [redacted] again");
		expect(redactMcpText("this is abc", ["abc"])).toBe("this is abc");
		expect(redactMcpText("trim me please", ["  please  "])).toBe("trim me [redacted]");
		expect(redactMcpText("nothing secret here")).toBe("nothing secret here");
	});

	test("the scheme can be stripped from a header value", () => {
		expect(stripAuthScheme("Bearer abc")).toBe("abc");
		expect(stripAuthScheme("basic abc")).toBe("abc");
		expect(stripAuthScheme("abc")).toBe("abc");
	});
});
