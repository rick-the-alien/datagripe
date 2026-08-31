import type { AppDb } from "./pool";

/**
 * Idempotency for mutating WebSocket actions (docs/initial_idea.md §10):
 * the first execution stores its response; retries with the same key
 * replay the stored response instead of re-running the mutation.
 */
export async function withIdempotency<T>(
	appDb: AppDb,
	workspaceId: string,
	action: string,
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const existing = await appDb<{ response: unknown }[]>`
		SELECT response FROM idempotency_keys
		WHERE workspace_id = ${workspaceId} AND action = ${action} AND key = ${key}
	`;
	const row = existing[0];
	if (row !== undefined) {
		// Bun.SQL returns jsonb as raw text; parse unless the driver already did.
		const stored: unknown =
			typeof row.response === "string"
				? JSON.parse(row.response)
				: row.response;
		// Cast to named const: we wrote this value through JSON.stringify below.
		const replayed = stored as T;
		return replayed;
	}

	const result = await fn();
	try {
		await appDb`
			INSERT INTO idempotency_keys (workspace_id, action, key, response)
			VALUES (${workspaceId}, ${action}, ${key}, ${JSON.stringify(result)})
		`;
	} catch {
		// Concurrent retry inserted first — the stored response is
		// equivalent; returning our result is safe.
	}
	return result;
}
