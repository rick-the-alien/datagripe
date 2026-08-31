import { z } from "zod";

/** Connection contracts. Secrets are write-only; never serialized back to clients. */

export const connectionAdapterSchema = z.enum(["postgres"]);

export type ConnectionAdapter = z.infer<typeof connectionAdapterSchema>;

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
	host: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535),
	databaseName: z.string().min(1).max(255),
	username: z.string().min(1).max(255),
	tlsMode: tlsModeSchema,
	readOnly: z.boolean(),
	source: connectionSourceSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type ConnectionMetadata = z.infer<typeof connectionMetadataSchema>;

export const connectionCreateRequestSchema = z.object({
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	host: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535),
	databaseName: z.string().min(1).max(255),
	username: z.string().min(1).max(255),
	password: z.string().max(1024),
	tlsMode: tlsModeSchema,
	readOnly: z.boolean().default(true),
	idempotencyKey: z.string().min(8).max(128),
});

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
	z.object({
		draft: connectionCreateRequestSchema.omit({ idempotencyKey: true }),
	}),
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
