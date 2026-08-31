import { z } from "zod";
import { connectionAdapterSchema } from "./adapters";
import { tlsModeSchema } from "./connections";

/**
 * Predefined connections declared in a server config file
 * (docs/spec/connection-sources.md). Validated at boot; invalid files
 * fail startup with per-entry error messages.
 */

export const predefinedConnectionSchema = z
	.object({
		/** Stable kebab-case slug; disjoint from managed UUID ids. */
		id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case"),
		name: z.string().min(1).max(255),
		adapter: connectionAdapterSchema,
		host: z.string().min(1).max(255).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		database: z.string().min(1).max(1024),
		username: z.string().max(255).optional(),
		/** Indirection into the process environment (preferred). */
		passwordEnv: z.string().min(1).max(255).optional(),
		/** Inline secret — development only. */
		password: z.string().max(1024).optional(),
		tlsMode: tlsModeSchema.default("disable"),
		readOnly: z.boolean().default(true),
		/** Workspace names, or ["*"] for every workspace. */
		workspaces: z.array(z.string().min(1)).min(1),
	})
	.check((ctx) => {
		const value = ctx.value;
		if (value.adapter !== "sqlite") {
			if (value.host === undefined) {
				ctx.issues.push({
					code: "custom",
					message: "host is required",
					path: ["host"],
					input: value,
				});
			}
			if (value.port === undefined) {
				ctx.issues.push({
					code: "custom",
					message: "port is required",
					path: ["port"],
					input: value,
				});
			}
		}
		if (value.passwordEnv === undefined && value.password === undefined) {
			ctx.issues.push({
				code: "custom",
				message: "either passwordEnv or password is required",
				path: ["passwordEnv"],
				input: value,
			});
		}
	});

export type PredefinedConnection = z.infer<typeof predefinedConnectionSchema>;

export const predefinedConnectionsFileSchema = z
	.object({
		connections: z.array(predefinedConnectionSchema),
	})
	.check((ctx) => {
		const seen = new Set<string>();
		for (const [index, connection] of ctx.value.connections.entries()) {
			if (seen.has(connection.id)) {
				ctx.issues.push({
					code: "custom",
					message: `duplicate predefined connection id '${connection.id}'`,
					path: ["connections", index, "id"],
					input: connection.id,
				});
			}
			seen.add(connection.id);
		}
	});

export type PredefinedConnectionsFile = z.infer<
	typeof predefinedConnectionsFileSchema
>;
