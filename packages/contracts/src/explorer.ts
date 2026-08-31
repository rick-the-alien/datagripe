import { z } from "zod";

/**
 * Schema explorer contracts. The tree is lazily loaded one level at a
 * time via the `schema.children` WebSocket action:
 *
 *   connection                 path: []
 *   └── schema                 path: [schema]
 *       ├── tables (category)  path: [schema, tables]
 *       │   └── table          path: [schema, tables, table]  → columns
 *       └── views (category)   path: [schema, views]
 *           └── view           path: [schema, views, view]    → columns
 */

export const schemaNodeKindSchema = z.enum([
	"schema",
	"tables",
	"views",
	"table",
	"view",
	"column",
]);

export type SchemaNodeKind = z.infer<typeof schemaNodeKindSchema>;

export const schemaPathSegmentSchema = z.object({
	kind: schemaNodeKindSchema,
	name: z.string().min(1).max(255),
});

export type SchemaPathSegment = z.infer<typeof schemaPathSegmentSchema>;

export const schemaChildrenRequestSchema = z.object({
	/** Managed UUID or predefined slug. */
	connectionId: z.string().min(1).max(255),
	/** Segments from the connection root to the node being expanded. */
	path: z.array(schemaPathSegmentSchema).max(8).default([]),
	/** Bypass the server's short-lived introspection cache. */
	refresh: z.boolean().default(false),
});

export type SchemaChildrenRequest = z.infer<typeof schemaChildrenRequestSchema>;

export const schemaNodeSchema = z.object({
	kind: schemaNodeKindSchema,
	name: z.string().min(1).max(255),
	hasChildren: z.boolean(),
	/** Columns only. */
	dataType: z.string().max(255).optional(),
	/** Columns only. */
	nullable: z.boolean().optional(),
});

export type SchemaNode = z.infer<typeof schemaNodeSchema>;

export const schemaChildrenResultSchema = z.object({
	nodes: z.array(schemaNodeSchema),
});

export type SchemaChildrenResult = z.infer<typeof schemaChildrenResultSchema>;
