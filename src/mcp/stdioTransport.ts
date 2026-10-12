import { NotificationHub, type McpTransport, type NotificationListener, type PostOptions, type TransportReply } from "./transport";
import {
	type InboundMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type RequestId,
	McpClientError,
	parseInbound,
	parseJson
} from "./protocol";
import { redactMcpText } from "./redact";

/** Imperative shell for stdio: owns one child process, newline-delimited JSON framing, pending requests and shutdown. */

export interface ChildLike {
	readonly stdin: { write(data: string): boolean; end(): void; on(event: "error", listener: (error: Error) => void): unknown };
	readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
	readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	/** Signals the child and, when the launcher put it in its own process group, everything it started (npx, uvx and wrapper scripts run the real server as a child). */
	kill(signal?: "SIGTERM" | "SIGKILL"): boolean;
	/**
	 * True while something the child started is still running, even though the child itself has gone. Optional: a child that cannot
	 * have descendants, or a platform that cannot tell, leaves it out.
	 */
	hasSurvivors?(): boolean;
}

export interface LineState {
	readonly pending: string;
}

/** Pure framing. Lines longer than `maxLine` set `overflow` so the caller can kill a server that never sends a newline. */
export function feedLines(state: LineState, chunk: string, maxLine: number): { state: LineState; lines: string[]; overflow: boolean } {
	const combined = state.pending + chunk;
	const parts = combined.split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts.map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
	const overflow = rest.length > maxLine || lines.some((line) => line.length > maxLine);
	return { state: { pending: overflow ? "" : rest }, lines, overflow };
}

interface Pending {
	readonly resolve: (reply: TransportReply) => void;
	readonly reject: (error: McpClientError) => void;
	readonly cleanup: () => void;
}

export interface StdioOptions {
	readonly maxLineBytes?: number;
	readonly stderrTail?: number;
	readonly graceMs?: number;
	/** Secret values this server was started with, masked in every message built from its stderr. */
	readonly secrets?: readonly string[];
}

/** How much of the stderr tail goes into an error message. The buffer itself is larger so a redactor can see whole tokens. */
const STDERR_HINT_CHARS = 1000;

export class StdioTransport implements McpTransport {
	readonly kind = "stdio" as const;
	readonly hasSession = false;
	private readonly pending = new Map<RequestId, Pending>();
	private readonly hub = new NotificationHub();
	private lineState: LineState = { pending: "" };
	private stderrBuffer = "";
	private readonly exited: Promise<void>;
	private hasExited = false;
	private closed = false;
	private failure: McpClientError | null = null;

	constructor(private readonly child: ChildLike, private readonly options: StdioOptions = {}) {
		let markExited: () => void = () => undefined;
		this.exited = new Promise<void>((resolve) => { markExited = resolve; });
		const finish = (): void => {
			this.hasExited = true;
			markExited();
		};
		child.stdout.on("data", (chunk) => this.onStdout(String(chunk)));
		child.stderr.on("data", (chunk) => {
			this.stderrBuffer = (this.stderrBuffer + String(chunk)).slice(-(options.stderrTail ?? 4096));
		});
		child.stdin.on("error", (error) => this.fail(new McpClientError("transport", `The server closed its input: ${this.redact(error.message)}`)));
		// Node may never emit "exit" after "error" (a command that cannot be found), so both end the process for our purposes.
		child.on("error", (error) => {
			this.fail(new McpClientError("transport", `Could not start the server: ${this.redact(error.message)}`));
			finish();
		});
		child.on("exit", (code, signal) => {
			this.fail(new McpClientError("transport", `The server stopped (${signal ?? `exit code ${String(code)}`}).${this.stderrHint()}`));
			finish();
		});
	}

	private redact(text: string): string {
		return redactMcpText(text, this.options.secrets ?? []);
	}

	/** The last part of what the server wrote to stderr, already redacted. stderr is free-form logging, so it is only a hint. */
	stderrHint(): string {
		const tail = this.redact(this.stderrBuffer).trim().slice(-STDERR_HINT_CHARS);
		return tail ? ` It said: ${tail}` : "";
	}

	onNotification(listener: NotificationListener): () => void {
		return this.hub.subscribe(listener);
	}

	private onStdout(chunk: string): void {
		const fed = feedLines(this.lineState, chunk, this.options.maxLineBytes ?? 8 * 1024 * 1024);
		this.lineState = fed.state;
		if (fed.overflow) {
			this.fail(new McpClientError("protocol", "The server sent a message larger than AskMate accepts, so it was stopped."));
			this.child.kill("SIGKILL");
			return;
		}
		fed.lines.forEach((line) => this.dispatch(parseInbound(parseJson(line))));
	}

	private dispatch(message: InboundMessage | null): void {
		if (message === null) {
			return;
		}
		switch (message.kind) {
			case "result":
			case "error": {
				const entry = message.id === null ? undefined : this.pending.get(message.id);
				if (entry) {
					entry.cleanup();
					entry.resolve({ kind: "rpc", reply: message });
				}
				return;
			}
			case "notification":
				this.hub.emit(message.method);
				return;
			case "request":
				// A legacy server may ping. Anything else it asks for is something AskMate did not declare, so refuse politely.
				this.write(message.method === "ping"
					? { jsonrpc: "2.0", id: message.id, result: {} }
					: { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
				return;
		}
	}

	/** A write to a dead pipe must not throw into a timer or a signal handler, so it becomes a transport failure instead. */
	private write(payload: object): void {
		try {
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch (error) {
			this.fail(new McpClientError("transport", `The server closed its input: ${this.redact(error instanceof Error ? error.message : String(error))}`));
		}
	}

	private fail(error: McpClientError): void {
		this.failure ??= error;
		const failure = this.failure;
		[...this.pending.values()].forEach((entry) => {
			entry.cleanup();
			entry.reject(failure);
		});
		this.pending.clear();
	}

	post(message: JsonRpcRequest, options: PostOptions): Promise<TransportReply> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		if (options.signal?.aborted) {
			return Promise.reject(new McpClientError("aborted", "Stopped."));
		}
		return new Promise<TransportReply>((resolve, reject) => {
			let timer: number | null = null;
			const cleanup = (): void => {
				if (timer !== null) {
					window.clearTimeout(timer);
				}
				options.signal?.removeEventListener("abort", onAbort);
			};
			const settle = (error: McpClientError): void => {
				// stdio has no per-request stream to close, so cancellation must be told to the server (spec: MUST).
				this.pending.delete(message.id);
				cleanup();
				this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: message.id, reason: error.message } });
				reject(error);
			};
			const onAbort = (): void => settle(new McpClientError("aborted", "Stopped."));
			timer = window.setTimeout(() => settle(new McpClientError("timeout", `The server did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`)), options.timeoutMs);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(message.id, { resolve, reject, cleanup });
			this.write(message);
		});
	}

	notify(message: JsonRpcNotification): Promise<void> {
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		this.write(message);
		return Promise.resolve();
	}

	resetSession(): void {
		// stdio has no sessions. A dead process is replaced by creating a new transport.
	}

	/**
	 * Spec order: close stdin, wait, SIGTERM, wait, SIGKILL. Once the child is gone, whatever it started and left running gets
	 * the same two steps, so a wrapper that exits does not leave its server behind.
	 */
	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.failure ??= new McpClientError("transport", "The connection was closed.");
		this.fail(this.failure);
		if (this.hasExited) {
			// Not swept: the exit was not seen by this call, and a process group number that old may belong to someone else by now.
			return;
		}
		const grace = this.options.graceMs ?? 2000;
		const exitedWithin = async (ms: number): Promise<boolean> => {
			let timer: number | null = null;
			const timeout = new Promise<boolean>((resolve) => { timer = window.setTimeout(() => resolve(false), ms); });
			const won = await Promise.race([this.exited.then(() => true), timeout]);
			if (timer !== null) {
				window.clearTimeout(timer);
			}
			return won;
		};
		this.child.stdin.end();
		if (!(await exitedWithin(grace))) {
			this.child.kill("SIGTERM");
			if (!(await exitedWithin(grace))) {
				this.child.kill("SIGKILL");
				return;
			}
		}
		await this.stopSurvivors(grace);
	}

	/** The child has exited. If it left descendants running, ask them to stop, wait, then kill what is still there. */
	private async stopSurvivors(grace: number): Promise<void> {
		const survivors = (): boolean => this.child.hasSurvivors?.() === true;
		if (!survivors()) {
			return;
		}
		this.child.kill("SIGTERM");
		const deadline = Date.now() + grace;
		while (survivors() && Date.now() < deadline) {
			await new Promise<void>((resolve) => { window.setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))); });
		}
		if (survivors()) {
			this.child.kill("SIGKILL");
		}
	}
}
