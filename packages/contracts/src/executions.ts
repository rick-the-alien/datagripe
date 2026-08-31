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
	connectionId: z.uuid(),
	documentId: z.uuid().optional(),
	editorViewId: z.string().optional(),
	sql: z.string().min(1),
	idempotencyKey: z.string().min(8).max(128),
});

export type ExecutionStartRequest = z.infer<typeof executionStartRequestSchema>;

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

export const executionColumnsPayloadSchema = z.object({
	columns: z.array(columnDescriptorSchema),
});

export const executionRowsPayloadSchema = z.object({
	rows: z.array(z.array(z.unknown())),
	rowOffset: z.number().int().nonnegative(),
});

export const executionCompletedPayloadSchema = z.object({
	rowCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
	elapsedMs: z.number().nonnegative(),
});

export const executionFailedPayloadSchema = z.object({
	code: z.string().optional(),
	message: z.string(),
	position: z.number().int().nonnegative().optional(),
});
