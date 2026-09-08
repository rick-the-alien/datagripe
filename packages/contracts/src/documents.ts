import { z } from "zod";

/** Document and editor-view domain contracts. */

/**
 * Where a document came from, when it did not come from nowhere.
 *
 * A file opened out of a datasource path (docs/spec/datasource-paths.md)
 * is a normal workspace document — cached in the app database so it gets
 * the same live multiplayer state as any shared file — that additionally
 * knows which file on disk it *is*. Saves write both.
 */
export const documentOriginSchema = z.object({
	/** `ConnectionMetadata.id`: a managed UUID or a predefined slug. */
	connectionRef: z.string().min(1).max(255),
	/** `DatasourcePath.id` — which configured root it lives under. */
	pathId: z.uuid(),
	/** POSIX-relative to that root. */
	filePath: z.string().min(1).max(1024),
});

export type DocumentOrigin = z.infer<typeof documentOriginSchema>;

export const documentSchema = z.object({
	id: z.uuid(),
	workspaceId: z.uuid(),
	title: z.string().min(1).max(255),
	language: z.literal("sql"),
	content: z.string(),
	revision: z.number().int().nonnegative(),
	defaultConnectionId: z.uuid().optional(),
	/** Null for scratchpads and plain workspace files. */
	origin: documentOriginSchema.nullable().default(null),
	updatedAt: z.iso.datetime(),
});

export type Document = z.infer<typeof documentSchema>;

export const documentSaveRequestSchema = z.object({
	id: z.uuid(),
	content: z.string(),
	revision: z.number().int().nonnegative(),
	/** Rename during save. */
	title: z.string().min(1).max(255).optional(),
	/** Overwrite despite a revision mismatch (user chose keep-mine). */
	force: z.boolean().default(false),
	idempotencyKey: z.string().min(8).max(128),
});

export type DocumentSaveRequest = z.infer<typeof documentSaveRequestSchema>;

export const documentCreateRequestSchema = z.object({
	/** Client-chosen id keeps local and server ids aligned (idempotent). */
	id: z.uuid().optional(),
	title: z.string().min(1).max(255),
	content: z.string().default(""),
	defaultConnectionId: z.uuid().optional(),
	idempotencyKey: z.string().min(8).max(128),
});

export type DocumentCreateRequest = z.infer<typeof documentCreateRequestSchema>;
