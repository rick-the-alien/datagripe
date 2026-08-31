import type {
	ConnectionTestResult,
	SchemaNode,
	SchemaPathSegment,
} from "@datagripe/contracts";
import { ADAPTER_CAPABILITIES } from "@datagripe/contracts";
import {
	type DatabaseAdapter,
	type ExecutionSession,
	InvalidIntrospectionPathError,
	type KeyValue,
	type ResolvedConnection,
} from "../types";

/**
 * Redis adapter (docs/spec/adapters.md) — a distinct capability, not a
 * SQL database: connection test via PING, keyspace browsing via SCAN
 * (prefix tree over the ":" delimiter), and value fetches per key.
 * No SQL execution (capabilities.execution === null).
 */

const SCAN_COUNT = 1_000;
const MAX_KEYS_PER_LEVEL = 10_000;
const MAX_VALUE_ENTRIES = 100;
const PREFIX_DELIMITER = ":";

type Redis = InstanceType<typeof Bun.RedisClient>;

export class RedisAdapter implements DatabaseAdapter {
	readonly adapterId = "redis" as const;
	readonly capabilities = ADAPTER_CAPABILITIES.redis;

	private readonly clients = new Map<string, Redis>();

	private clientFor(connection: ResolvedConnection): Redis {
		const passwordFingerprint = new Bun.CryptoHasher("sha256")
			.update(connection.password)
			.digest("hex")
			.slice(0, 16);
		const key = [
			connection.host,
			connection.port,
			connection.database,
			connection.username,
			connection.tlsMode,
			passwordFingerprint,
		].join(":");
		let client = this.clients.get(key);
		if (client === undefined) {
			const dbIndex = Number.parseInt(connection.database || "0", 10);
			const scheme = connection.tlsMode !== "disable" ? "rediss" : "redis";
			const auth =
				connection.username !== ""
					? `${encodeURIComponent(connection.username)}:${encodeURIComponent(connection.password)}@`
					: connection.password !== ""
						? `:${encodeURIComponent(connection.password)}@`
						: "";
			client = new Bun.RedisClient(
				`${scheme}://${auth}${connection.host}:${connection.port}/${Number.isInteger(dbIndex) ? dbIndex : 0}`,
			);
			this.clients.set(key, client);
		}
		return client;
	}

	async testConnection(
		connection: ResolvedConnection,
	): Promise<ConnectionTestResult> {
		const started = performance.now();
		try {
			const client = this.clientFor(connection);
			await client.connect();
			const info = (await client.send("INFO", ["server"])) as string;
			const version = /redis_version:([^\r\n]+)/.exec(info)?.[1];
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - started),
				...(version !== undefined ? { serverVersion: `Redis ${version}` } : {}),
			};
		} catch (error) {
			return {
				ok: false,
				error: {
					message: error instanceof Error ? error.message : "Connection failed",
				},
			};
		}
	}

	/** SCAN one level's keys (with a prefix pattern), bounded. */
	private async scanKeys(
		client: Redis,
		pattern: string,
	): Promise<{ keys: string[]; truncated: boolean }> {
		const keys: string[] = [];
		let cursor = "0";
		do {
			const [next, batch] = (await client.send("SCAN", [
				cursor,
				"MATCH",
				pattern,
				"COUNT",
				String(SCAN_COUNT),
			])) as [string, string[]];
			cursor = next;
			keys.push(...batch);
			if (keys.length >= MAX_KEYS_PER_LEVEL) {
				return { keys: keys.slice(0, MAX_KEYS_PER_LEVEL), truncated: true };
			}
		} while (cursor !== "0");
		return { keys, truncated: false };
	}

	async introspectChildren(
		connection: ResolvedConnection,
		path: SchemaPathSegment[],
	): Promise<SchemaNode[]> {
		const client = this.clientFor(connection);
		await client.connect();

		if (path.length === 0) {
			// One level per db index would need CONFIG GET databases; keep the
			// connected db as a single root node.
			const dbIndex = Number.parseInt(connection.database || "0", 10);
			return [
				{
					kind: "db",
					name: `db${Number.isInteger(dbIndex) ? dbIndex : 0}`,
					hasChildren: true,
				},
			];
		}

		const [dbSegment, ...rest] = path;
		if (dbSegment === undefined || dbSegment.kind !== "db") {
			throw new InvalidIntrospectionPathError(path);
		}
		const prefix = rest.map((segment) => segment.name).join(PREFIX_DELIMITER);
		const pattern = prefix === "" ? "*" : `${prefix}${PREFIX_DELIMITER}*`;
		const { keys, truncated } = await this.scanKeys(client, pattern);

		// Group into immediate child prefixes vs leaf keys.
		const prefixes = new Set<string>();
		const leaves: string[] = [];
		const strip = prefix === "" ? "" : `${prefix}${PREFIX_DELIMITER}`;
		for (const key of keys) {
			const remainder = key.startsWith(strip) ? key.slice(strip.length) : key;
			const delimiterAt = remainder.indexOf(PREFIX_DELIMITER);
			if (delimiterAt === -1) {
				leaves.push(remainder);
			} else {
				prefixes.add(remainder.slice(0, delimiterAt));
			}
		}

		const nodes: SchemaNode[] = [];
		for (const name of [...prefixes].sort()) {
			nodes.push({ kind: "prefix", name, hasChildren: true });
		}
		for (const name of leaves.sort()) {
			nodes.push({ kind: "key", name, hasChildren: false });
		}
		if (truncated && nodes.length > 0) {
			// Surface scan truncation as a synthetic marker node.
			nodes.push({
				kind: "prefix",
				name: `… (truncated at ${MAX_KEYS_PER_LEVEL} keys)`,
				hasChildren: false,
			});
		}
		return nodes;
	}

	async getKeyValue(
		connection: ResolvedConnection,
		key: string,
	): Promise<KeyValue> {
		const client = this.clientFor(connection);
		await client.connect();

		const type = (await client.send("TYPE", [key])) as string;
		const ttl = Number(await client.send("TTL", [key]));
		const truncatedMarker = { truncated: false };

		switch (type) {
			case "string": {
				const value = (await client.get(key)) ?? "";
				return {
					key,
					type: "string",
					ttlSeconds: ttl,
					entries: [{ value }],
					...truncatedMarker,
				};
			}
			case "hash": {
				// Bun's driver returns HGETALL as an object, not a flat array.
				const raw = (await client.send("HGETALL", [key])) as
					| Record<string, string>
					| string[];
				const pairs = Array.isArray(raw)
					? Array.from(
							{ length: Math.floor(raw.length / 2) },
							(_, i) => [raw[i * 2] ?? "", raw[i * 2 + 1] ?? ""] as const,
						)
					: Object.entries(raw);
				const entries = pairs
					.slice(0, MAX_VALUE_ENTRIES)
					.map(([field, value]) => ({ field, value }));
				return {
					key,
					type: "hash",
					ttlSeconds: ttl,
					entries,
					truncated: pairs.length > MAX_VALUE_ENTRIES,
				};
			}
			case "list": {
				const raw = (await client.send("LRANGE", [
					key,
					"0",
					String(MAX_VALUE_ENTRIES - 1),
				])) as string[];
				const total = Number(await client.send("LLEN", [key]));
				return {
					key,
					type: "list",
					ttlSeconds: ttl,
					entries: raw.map((value, index) => ({
						field: String(index),
						value,
					})),
					truncated: total > MAX_VALUE_ENTRIES,
				};
			}
			case "set": {
				const raw = (await client.send("SMEMBERS", [key])) as string[];
				return {
					key,
					type: "set",
					ttlSeconds: ttl,
					entries: raw.slice(0, MAX_VALUE_ENTRIES).map((value) => ({ value })),
					truncated: raw.length > MAX_VALUE_ENTRIES,
				};
			}
			case "zset": {
				const raw = (await client.send("ZRANGE", [
					key,
					"0",
					String(MAX_VALUE_ENTRIES - 1),
					"WITHSCORES",
				])) as string[];
				const entries: Array<{ field: string; value: string }> = [];
				for (let i = 0; i + 1 < raw.length; i += 2) {
					entries.push({ field: raw[i + 1] ?? "", value: raw[i] ?? "" });
				}
				return {
					key,
					type: "zset",
					ttlSeconds: ttl,
					entries,
					truncated: false,
				};
			}
			default:
				return {
					key,
					type: "other",
					ttlSeconds: ttl,
					entries: [{ value: `(type '${type}' is not rendered)` }],
					truncated: false,
				};
		}
	}

	beginExecution(): Promise<ExecutionSession> {
		throw new Error("Redis does not support SQL execution");
	}

	async close(): Promise<void> {
		for (const client of this.clients.values()) {
			client.close();
		}
		this.clients.clear();
	}
}
