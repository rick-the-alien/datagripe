import { z } from "zod";
import type { executionEventTopicSchema } from "./executions";

/**
 * Versioned, bidirectional WebSocket protocol.
 * Every client request carries a requestId; long-running work continues
 * through correlated events.
 */

export const WS_PROTOCOL_VERSION = 1;

export const clientActionSchema = z.enum([
	"workspace.open",
	"workspace.create",
	"workspace.list",
	"workspace.set-default-connection",
	"workspace.rename",
	"workspace.members",
	"workspace.member.add",
	"workspace.member.remove",
	"layout.save",
	"document.get",
	"document.create",
	"document.save",
	"document.archive",
	"document.focus",
	"view.broadcast",
	"view.follow",
	"view.unfollow",
	"connection.create",
	"connection.update",
	"connection.test",
	"connection.delete",
	"schema.children",
	"redis.get",
	"execution.start",
	"execution.cancel",
	"execution.subscribe",
	"history.list",
]);

export type ClientAction = z.infer<typeof clientActionSchema>;

export const clientRequestSchema = z.object({
	version: z.literal(WS_PROTOCOL_VERSION),
	kind: z.literal("request"),
	requestId: z.string().min(1).max(64),
	action: clientActionSchema,
	payload: z.unknown(),
});

export type ClientRequest<T = unknown> = {
	version: typeof WS_PROTOCOL_VERSION;
	kind: "request";
	requestId: string;
	action: ClientAction;
	payload: T;
};

export const serverResponseSchema = z.object({
	version: z.literal(WS_PROTOCOL_VERSION),
	kind: z.literal("response"),
	requestId: z.string(),
	ok: z.boolean(),
	payload: z.unknown().optional(),
	error: z
		.object({
			code: z.string(),
			message: z.string(),
			requestId: z.string(),
			details: z.unknown().optional(),
		})
		.optional(),
});

export type ServerResponse<T = unknown> = {
	version: typeof WS_PROTOCOL_VERSION;
	kind: "response";
	requestId: string;
	ok: boolean;
	payload?: T;
	error?: {
		code: string;
		message: string;
		requestId: string;
		details?: unknown;
	};
};

export const serverEventSchema = z.object({
	version: z.literal(WS_PROTOCOL_VERSION),
	kind: z.literal("event"),
	eventId: z.string(),
	topic: z.string(),
	executionId: z.string().optional(),
	sequence: z.number().int().nonnegative().optional(),
	occurredAt: z.iso.datetime(),
	payload: z.unknown(),
});

export type ServerEvent<T = unknown> = {
	version: typeof WS_PROTOCOL_VERSION;
	kind: "event";
	eventId: string;
	topic: string | z.infer<typeof executionEventTopicSchema>;
	executionId?: string;
	sequence?: number;
	occurredAt: string;
	payload: T;
};

export type ServerMessage = ServerResponse | ServerEvent;
