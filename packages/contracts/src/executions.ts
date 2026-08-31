import { z } from "zod";

/** Query execution lifecycle contracts. */

export const executionStatusSchema = z.enum([
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
]);

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const executionStartRequestSchema = z.object({
	/** Managed UUID or predefined slug. */
	connectionId: z.string().min(1).max(255),
	documentId: z.uuid().optional(),
	editorViewId: z.string().optional(),
	sql: z.string().min(1),
	idempotencyKey: z.string().min(8).max(128),
});

export type ExecutionStartRequest = z.infer<typeof executionStartRequestSchema>;

export const executionStartResultSchema = z.object({
	executionId: z.uuid(),
});

export type ExecutionStartResult = z.infer<typeof executionStartResultSchema>;

export const executionCancelRequestSchema = z.object({
	executionId: z.uuid(),
});

export type ExecutionCancelRequest = z.infer<
	typeof executionCancelRequestSchema
>;

export const executionCancelResultSchema = z.object({
	executionId: z.uuid(),
	status: executionStatusSchema,
});

export type ExecutionCancelResult = z.infer<typeof executionCancelResultSchema>;

export const executionSubscribeRequestSchema = z.object({
	executionId: z.uuid(),
	/** Replay events with sequence greater than this (0 = from the start). */
	afterSequence: z.number().int().nonnegative().default(0),
});

export type ExecutionSubscribeRequest = z.infer<
	typeof executionSubscribeRequestSchema
>;

export const executionEventTopicSchema = z.enum([
	"execution.started",
	"execution.columns",
	"execution.rows",
	"execution.progress",
	"execution.completed",
	"execution.failed",
	"execution.cancelled",
]);

export type ExecutionEventTopic = z.infer<typeof executionEventTopicSchema>;

export const columnDescriptorSchema = z.object({
	name: z.string(),
	dataType: z.string(),
});

export type ColumnDescriptor = z.infer<typeof columnDescriptorSchema>;

export const executionStartedPayloadSchema = z.object({
	startedAt: z.iso.datetime(),
	statements: z.number().int().positive(),
	/** Executor identity — cancel permission + attribution (6d/6e). */
	userId: z.uuid(),
});

export const executionColumnsPayloadSchema = z.object({
	/** Which statement's result set these columns belong to (0-based). */
	resultSet: z.number().int().nonnegative(),
	columns: z.array(columnDescriptorSchema),
});

export const executionRowsPayloadSchema = z.object({
	resultSet: z.number().int().nonnegative(),
	rows: z.array(z.array(z.unknown())),
	rowOffset: z.number().int().nonnegative(),
});

export const executionProgressPayloadSchema = z.object({
	/** 1-based statement ordinal that just finished. */
	statement: z.number().int().positive(),
	/** Postgres command tag verb (INSERT, UPDATE, CREATE TABLE, …). */
	command: z.string(),
	affectedRows: z.number().int().nonnegative().optional(),
});

export const executionCompletedPayloadSchema = z.object({
	rowCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
	elapsedMs: z.number().nonnegative(),
	statements: z.number().int().positive(),
});

export const executionFailedPayloadSchema = z.object({
	code: z.string().optional(),
	message: z.string(),
	position: z.number().int().nonnegative().optional(),
});

export const executionCancelledPayloadSchema = z.object({
	elapsedMs: z.number().nonnegative(),
});

/** History metadata for one past execution (query_executions row). */
export const historyEntrySchema = z.object({
	id: z.uuid(),
	connectionId: z.string().min(1).max(255),
	connectionName: z.string().min(1).max(255),
	/** Executor identity (multiplayer 6d/6e attribution). */
	actorEmail: z.string(),
	documentId: z.uuid().nullable(),
	status: executionStatusSchema,
	preview: z.string(),
	startedAt: z.iso.datetime().nullable(),
	finishedAt: z.iso.datetime().nullable(),
	rowCount: z.number().int().nonnegative().nullable(),
	truncated: z.boolean().nullable(),
	errorCode: z.string().nullable(),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const historyListRequestSchema = z.object({
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().nonnegative().default(0),
	/** "mine" = own executions; "workspace" = every member's (6d). */
	scope: z.enum(["mine", "workspace"]).default("mine"),
});

export type HistoryListRequest = z.infer<typeof historyListRequestSchema>;

export const historyListResultSchema = z.object({
	entries: z.array(historyEntrySchema),
	/** Total executions, for pagination display. */
	total: z.number().int().nonnegative(),
});

export type HistoryListResult = z.infer<typeof historyListResultSchema>;
