import type { HttpReplyLike } from "./wire";
import type { JsonRpcNotification, JsonRpcRequest, RpcReply } from "./protocol";

export interface PostOptions {
	/** Only the HTTP transport reads these. */
	readonly headers: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
}

/**
 * What a transport hands back. stdio only ever produces "rpc". HTTP produces "rpc" when it found the matching JSON-RPC reply
 * in a 2xx body, and "http" otherwise, so version negotiation can inspect statuses without exceptions steering control flow.
 */
export type TransportReply =
	| { readonly kind: "rpc"; readonly reply: RpcReply }
	| { readonly kind: "http"; readonly http: HttpReplyLike };

export type NotificationListener = (method: string) => void;

export interface McpTransport {
	readonly kind: "stdio" | "http";
	/** Rejects with McpClientError("timeout" | "aborted" | "transport"). Never retries by itself: tools/call may have side effects. */
	post(message: JsonRpcRequest, options: PostOptions): Promise<TransportReply>;
	notify(message: JsonRpcNotification, options: PostOptions): Promise<void>;
	/** True while a legacy HTTP session id is held. Always false for stdio and for modern servers. */
	readonly hasSession: boolean;
	/** Forgets a legacy session after the server answered 404 to it, so the client can run `initialize` again. */
	resetSession(): void;
	/** Server notifications seen on this transport: stdio lines, or events inside a buffered HTTP reply. Returns an unsubscribe function. */
	onNotification(listener: NotificationListener): () => void;
	/** Idempotent. Releases the process or HTTP session. */
	close(): Promise<void>;
}

/** Small shared helper so both transports fan notifications out the same way. */
export class NotificationHub {
	private readonly listeners = new Set<NotificationListener>();

	subscribe(listener: NotificationListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(method: string): void {
		[...this.listeners].forEach((listener) => listener(method));
	}
}
