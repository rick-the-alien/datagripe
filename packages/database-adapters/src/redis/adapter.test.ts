import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedConnection } from "../types";
import { RedisAdapter } from "./adapter";

/** Redis adapter integration test against the local container. */

const CONNECTION: ResolvedConnection = {
	adapter: "redis",
	host: "localhost",
	port: 6379,
	database: "0",
	username: "",
	password: "",
	tlsMode: "disable",
	readOnly: false,
};

async function probe(): Promise<boolean> {
	try {
		const client = new Bun.RedisClient("redis://localhost:6379/0");
		await client.connect();
		await client.send("PING", []);
		client.close();
		return true;
	} catch {
		return false;
	}
}

const reachable = await probe();
const redisTest = reachable ? test : test.skip;

const adapter = new RedisAdapter();

beforeAll(async () => {
	if (!reachable) {
		return;
	}
	const client = new Bun.RedisClient("redis://localhost:6379/0");
	await client.connect();
	await client.send("DEL", [
		"shop:products:1",
		"shop:products:2",
		"misc:flag",
		"shop:meta",
		"shop:recent",
	]);
	await client.send("MSET", [
		"shop:products:1",
		'{"sku":"SKU-1"}',
		"shop:products:2",
		'{"sku":"SKU-2"}',
		"misc:flag",
		"1",
	]);
	await client.send("HSET", ["shop:meta", "name", "demo", "region", "local"]);
	await client.send("RPUSH", ["shop:recent", "SKU-1", "SKU-2"]);
	client.close();
});

afterAll(async () => {
	await adapter.close();
});

describe("RedisAdapter", () => {
	redisTest("testConnection reports the Redis version", async () => {
		const result = await adapter.testConnection(CONNECTION);
		expect(result.ok).toBe(true);
		expect(result.serverVersion).toContain("Redis 7.");
	});

	redisTest("keyspace root shows the db node", async () => {
		const root = await adapter.introspectChildren(CONNECTION, []);
		expect(root).toEqual([{ kind: "db", name: "db0", hasChildren: true }]);
	});

	redisTest("prefix tree groups keys by delimiter", async () => {
		const top = await adapter.introspectChildren(CONNECTION, [
			{ kind: "db", name: "db0" },
		]);
		expect(top).toContainEqual({
			kind: "prefix",
			name: "shop",
			hasChildren: true,
		});
		expect(top).toContainEqual({
			kind: "prefix",
			name: "misc",
			hasChildren: true,
		});

		const shop = await adapter.introspectChildren(CONNECTION, [
			{ kind: "db", name: "db0" },
			{ kind: "prefix", name: "shop" },
		]);
		expect(shop).toContainEqual({
			kind: "prefix",
			name: "products",
			hasChildren: true,
		});
		expect(shop).toContainEqual({
			kind: "key",
			name: "meta",
			hasChildren: false,
		});
		expect(shop).toContainEqual({
			kind: "key",
			name: "recent",
			hasChildren: false,
		});

		const products = await adapter.introspectChildren(CONNECTION, [
			{ kind: "db", name: "db0" },
			{ kind: "prefix", name: "shop" },
			{ kind: "prefix", name: "products" },
		]);
		expect(products).toEqual([
			{ kind: "key", name: "1", hasChildren: false },
			{ kind: "key", name: "2", hasChildren: false },
		]);
	});

	redisTest("getKeyValue fetches strings with ttl", async () => {
		const value = await adapter.getKeyValue(CONNECTION, "misc:flag");
		expect(value).toMatchObject({
			key: "misc:flag",
			type: "string",
			ttlSeconds: -1,
			entries: [{ value: "1" }],
		});
	});

	redisTest("getKeyValue fetches hashes and lists", async () => {
		const hash = await adapter.getKeyValue(CONNECTION, "shop:meta");
		expect(hash.type).toBe("hash");
		expect(hash.entries).toContainEqual({ field: "name", value: "demo" });
		expect(hash.entries).toContainEqual({ field: "region", value: "local" });

		const list = await adapter.getKeyValue(CONNECTION, "shop:recent");
		expect(list.type).toBe("list");
		expect(list.entries).toEqual([
			{ field: "0", value: "SKU-1" },
			{ field: "1", value: "SKU-2" },
		]);
	});
});
