import { z } from "zod";
import { adapterInfoSchema, connectionAdapterSchema } from "./adapters";
import { documentListEntrySchema } from "./multiplayer";

/** Connection contracts. Secrets are write-only; never serialized back to clients. */

export type { ConnectionAdapter } from "./adapters";

export const tlsModeSchema = z.enum(["disable", "require", "verify-full"]);

export const connectionSourceSchema = z.enum(["managed", "predefined"]);

export type ConnectionSource = z.infer<typeof connectionSourceSchema>;

/** Safe connection metadata — what the browser may see. */
export const connectionMetadataSchema = z.object({
	/** Managed connections use UUIDs; predefined use kebab-case slugs. */
	id: z.string().min(1).max(255),
	workspaceId: z.uuid(),
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	/** Null for file-based adapters (SQLite). */
	host: z.string().min(1).max(255).nullable(),
	port: z.number().int().min(1).max(65535).nullable(),
	/** Database name, file path (SQLite), or DB index (Redis). */
	databaseName: z.string().min(1).max(1024),
	username: z.string().max(255).nullable(),
	tlsMode: tlsModeSchema.nullable(),
	readOnly: z.boolean(),
	source: connectionSourceSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type ConnectionMetadata = z.infer<typeof connectionMetadataSchema>;

const connectionBaseFields = z.object({
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	host: z.string().min(1).max(255).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	databaseName: z.string().min(1).max(1024),
	username: z.string().max(255).optional(),
	password: z.string().max(1024),
	tlsMode: tlsModeSchema.optional(),
	readOnly: z.boolean().default(true),
});

function checkAdapterFields(ctx: {
	value: z.infer<typeof connectionBaseFields>;
	issues: Array<Record<string, unknown>>;
}): void {
	const value = ctx.value;
	if (value.adapter === "sqlite") {
		return; // file path only; no host/port/auth fields apply
	}
	const missing: string[] = [];
	if (value.host === undefined) missing.push("host");
	if (value.port === undefined) missing.push("port");
	if (value.tlsMode === undefined) missing.push("tlsMode");
	if (value.adapter !== "redis" && value.username === undefined) {
		missing.push("username");
	}
	if (missing.length > 0) {
		ctx.issues.push({
			code: "custom",
			message: `${missing.join(", ")} required for ${value.adapter}`,
			path: ["adapter"],
			input: value,
		});
	}
}

/** Dialog-draft fields (no idempotency key). */
export const connectionDraftSchema = connectionBaseFields.check(
	checkAdapterFields as never,
);

export type ConnectionDraft = z.infer<typeof connectionDraftSchema>;

export const connectionCreateRequestSchema = connectionBaseFields
	.extend({ idempotencyKey: z.string().min(8).max(128) })
	.check(checkAdapterFields as never);

export type ConnectionCreateRequest = z.infer<
	typeof connectionCreateRequestSchema
>;

/** Partial update; an omitted password keeps the stored one. */
export const connectionUpdateRequestSchema = z.object({
	id: z.string().min(1).max(255),
	name: z.string().min(1).max(255).optional(),
	host: z.string().min(1).max(255).optional(),
	port: z.number().int().min(1).max(65535).optional(),
	databaseName: z.string().min(1).max(255).optional(),
	username: z.string().min(1).max(255).optional(),
	password: z.string().max(1024).optional(),
	tlsMode: tlsModeSchema.optional(),
	readOnly: z.boolean().optional(),
	idempotencyKey: z.string().min(8).max(128),
});

export type ConnectionUpdateRequest = z.infer<
	typeof connectionUpdateRequestSchema
>;

export const connectionDeleteRequestSchema = z.object({
	id: z.string().min(1).max(255),
	idempotencyKey: z.string().min(8).max(128),
});

export type ConnectionDeleteRequest = z.infer<
	typeof connectionDeleteRequestSchema
>;

/**
 * Test a saved connection by id, or an unsaved dialog draft (fields only;
 * never persisted by the test action).
 */
export const connectionTestRequestSchema = z.union([
	z.object({ connectionId: z.string().min(1).max(255) }),
	z.object({ draft: connectionDraftSchema }),
]);

export type ConnectionTestRequest = z.infer<typeof connectionTestRequestSchema>;

export const workspaceDescriptorSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(255),
});

export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;

/** Result payload of `workspace.open`. */
export const workspaceOpenResultSchema = z.object({
	workspace: workspaceDescriptorSchema,
	connections: z.array(connectionMetadataSchema),
	/** Capability descriptors for every registered adapter. */
	adapters: z.array(adapterInfoSchema),
	/** Shared workspace documents (metadata only; content via document.get). */
	documents: z.array(documentListEntrySchema),
});

export type WorkspaceOpenResult = z.infer<typeof workspaceOpenResultSchema>;

export const connectionTestResultSchema = z.object({
	ok: z.boolean(),
	latencyMs: z.number().nonnegative().optional(),
	serverVersion: z.string().optional(),
	error: z
		.object({
			code: z.string().optional(),
			message: z.string(),
		})
		.optional(),
});

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
