import { z } from "zod";

/**
 * Schema explorer contracts. The tree is lazily loaded one level at a
 * time via the `schema.children` WebSocket action:
 *
 *   connection                    path: []
 *   └── schema                    path: [schema]
 *       ├── tables (category)     path: [schema, tables]
 *       │   └── table             path: [schema, tables, table]  → columns
 *       ├── views (category)      path: [schema, views]
 *       │   └── view              path: [schema, views, view]    → columns
 *       ├── functions (category)  path: [schema, functions]
 *       │   └── function          leaf (Postgres names carry the identity args)
 *       ├── procedures (category) path: [schema, procedures]     (MySQL)
 *       │   └── procedure         leaf
 *       └── sequences (category)  path: [schema, sequences]      (Postgres)
 *           └── sequence          leaf
 *
 * SQLite has no catalog routines, so its schemas only list tables/views.
 */

export const schemaNodeKindSchema = z.enum([
	"schema",
	"tables",
	"views",
	"functions",
	"procedures",
	"sequences",
	"table",
	"view",
	"function",
	"procedure",
	"sequence",
	"column",
	// Keyspace browsing (Redis): db index → key prefix → key.
	"db",
	"prefix",
	"key",
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

/** Fetch one key's value for the keyspace browser (`redis.get`). */
export const redisGetRequestSchema = z.object({
	connectionId: z.string().min(1).max(255),
	key: z.string().min(1).max(4096),
});

export type RedisGetRequest = z.infer<typeof redisGetRequestSchema>;

export const redisValueEntrySchema = z.object({
	/** Hash field / set member index, absent for plain strings. */
	field: z.string().optional(),
	value: z.string(),
});

export type RedisValueEntry = z.infer<typeof redisValueEntrySchema>;

export const redisGetResultSchema = z.object({
	key: z.string(),
	type: z.enum(["string", "hash", "list", "set", "zset", "other"]),
	/** -1 = no expiry, -2 = key vanished between browse and fetch. */
	ttlSeconds: z.number().int(),
	entries: z.array(redisValueEntrySchema),
	/** True when the value was capped (large collections show a prefix). */
	truncated: z.boolean(),
});

export type RedisGetResult = z.infer<typeof redisGetResultSchema>;
