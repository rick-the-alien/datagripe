import { z } from "zod";

/** Document and editor-view domain contracts. */

export const documentSchema = z.object({
	id: z.uuid(),
	workspaceId: z.uuid(),
	title: z.string().min(1).max(255),
	language: z.literal("sql"),
	content: z.string(),
	revision: z.number().int().nonnegative(),
	defaultConnectionId: z.uuid().optional(),
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
