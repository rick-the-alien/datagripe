import { log } from "./log";

/**
 * Surviving `bun --hot`.
 *
 * Hot reload re-evaluates the module graph **in the same process**, so
 * everything the entry point owns is created again while the previous
 * one is still alive: another connection pool, another sweep interval,
 * another pair of signal handlers. Six saves in, a dev cluster with
 * `max_connections = 100` has no connections left for anything else.
 *
 * There is no hook to fix this with. `import.meta.hot` is undefined
 * under `bun --hot` (Bun 1.4) — it exists for the frontend dev server,
 * not for server code — and `Bun.SQL`'s `idleTimeout` does not reap an
 * abandoned pool's sockets, which sit `idle` for as long as the process
 * lives.
 *
 * What does survive a reload is `globalThis`. So each evaluation stashes
 * a disposer for the resources it opened, and the next one runs them
 * before opening its own. The result is a reload that keeps the fresh
 * code — the point of `--hot` — without keeping the old sockets.
 *
 * The embedded PostgreSQL cluster is the exception: starting one takes
 * seconds and it is not the code being edited, so it is handed forward
 * rather than stopped and started on every save.
 */

export interface HotState<T> {
	/** Run at the start of the next evaluation, newest first. */
	disposers: Array<() => void | Promise<void>>;
	/** Handed forward across reloads instead of being re-created. */
	kept: T | null;
}

const KEY = "__datagripeHot";

export function hotState<T>(): HotState<T> {
	const holder = globalThis as unknown as Record<string, HotState<T>>;
	holder[KEY] ??= { disposers: [], kept: null };
	return holder[KEY] as HotState<T>;
}

/**
 * Close what the previous evaluation opened. Failures are logged and
 * skipped: a disposer that throws must not stop the reload, or one bad
 * save leaves a dev server that cannot start.
 */
export async function disposePrevious(state: HotState<unknown>): Promise<void> {
	const disposers = state.disposers.splice(0).reverse();
	if (disposers.length === 0) {
		return;
	}
	log.info("hot reload: closing the previous evaluation's resources", {
		disposers: disposers.length,
	});
	for (const dispose of disposers) {
		try {
			await dispose();
		} catch (error) {
			log.warn("hot reload: a disposer failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
