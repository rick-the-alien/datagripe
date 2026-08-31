import { z } from "zod";

/** Connection contracts. Secrets are write-only; never serialized back to clients. */

export const connectionAdapterSchema = z.enum(["postgres"]);

export type ConnectionAdapter = z.infer<typeof connectionAdapterSchema>;

export const tlsModeSchema = z.enum(["disable", "require", "verify-full"]);

/** Safe connection metadata — what the browser may see. */
export const connectionMetadataSchema = z.object({
	id: z.uuid(),
	workspaceId: z.uuid(),
	name: z.string().min(1).max(255),
	adapter: connectionAdapterSchema,
	host: z.string().min(1).max(255),
	port: z.number().int().min(1).max(65535),
	databaseName: z.string().min(1).max(255),
	username: z.string().min(1).max(255),
	tlsMode: tlsModeSchema,
	readOnly: z.boolean(),
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
