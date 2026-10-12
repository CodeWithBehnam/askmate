// A tiny stdio MCP server for end-to-end tests. Run with bun. Behaviour is chosen with environment variables:
//   MODE=modern|legacy|silent-legacy   which protocol era it speaks (legacy answers server/discover with method-not-found,
//                        silent-legacy does not answer it at all, like a server that ignores methods it does not know)
//   STUBBORN=1           ignores stdin closing and SIGTERM, so only SIGKILL stops it
//   FIXTURE_LOG=<path>   appends one line per notable event (cancelled requests, stdin closing)
import { appendFileSync } from "node:fs";

const mode = process.env.MODE ?? "modern";
const logPath = process.env.FIXTURE_LOG;
const log = (line: string): void => {
	if (logPath) {
		appendFileSync(logPath, `${line}\n`);
	}
};
const send = (message: unknown): void => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};

interface Request {
	id?: number | string;
	method: string;
	params?: { name?: string; arguments?: Record<string, unknown>; requestId?: number | string };
}

const tools = [
	{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
	{ name: "env", description: "Read an environment variable", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
	{ name: "sleep", description: "Wait for a while", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
	{ name: "repeat", description: "Repeat text many times", inputSchema: { type: "object", properties: { text: { type: "string" }, times: { type: "number" } } } }
];

function handle(message: Request): void {
	if (message.method === "notifications/cancelled") {
		log(`cancelled ${String(message.params?.requestId)}`);
		return;
	}
	if (message.id === undefined) {
		return;
	}
	const id = message.id;
	const reply = (result: unknown): void => send({ jsonrpc: "2.0", id, result });
	switch (message.method) {
		case "server/discover":
			if (mode === "silent-legacy") {
				log("discover-ignored");
			} else if (mode === "modern") {
				reply({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "FixtureModern", version: "1" } }, ttlMs: 1000 });
			} else {
				send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			}
			return;
		case "initialize":
			reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "FixtureLegacy", version: "1" } });
			return;
		case "tools/list":
			reply({ ...(mode === "modern" ? { resultType: "complete", ttlMs: 1000 } : {}), tools });
			return;
		case "tools/call": {
			const args = message.params?.arguments ?? {};
			if (message.params?.name === "echo") {
				reply({ content: [{ type: "text", text: `echo:${String(args.text)}` }] });
			} else if (message.params?.name === "env") {
				reply({ content: [{ type: "text", text: process.env[String(args.name)] ?? "(unset)" }] });
			} else if (message.params?.name === "repeat") {
				reply({ content: [{ type: "text", text: String(args.text).repeat(Number(args.times ?? 1)) }] });
			} else if (message.params?.name === "sleep") {
				setTimeout(() => reply({ content: [{ type: "text", text: "slept" }] }), Number(args.ms ?? 1000));
			} else {
				send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
			}
			return;
		}
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	lines.filter(Boolean).forEach((line) => handle(JSON.parse(line) as Request));
});
process.stdin.on("end", () => {
	log("stdin-closed");
	if (process.env.STUBBORN !== "1") {
		process.exit(0);
	}
});
if (process.env.STUBBORN === "1") {
	process.on("SIGTERM", () => log("sigterm-ignored"));
	setInterval(() => undefined, 1000);
}
log("started");
log(`pid ${process.pid}`);
