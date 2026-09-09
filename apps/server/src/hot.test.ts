import { describe, expect, test } from "bun:test";
import { disposePrevious, type HotState } from "./hot";

/**
 * Reload disposal (`hot.ts`). The property that matters is that a bad
 * disposer cannot stop a reload: one save that throws on the way down
 * would otherwise leave a dev server that will not come back up.
 */

function state(): HotState<unknown> {
	return { disposers: [], kept: null };
}

describe("hot reload disposal", () => {
	test("runs the disposers newest first", async () => {
		const order: string[] = [];
		const hot = state();
		hot.disposers.push(() => {
			order.push("pool");
		});
		hot.disposers.push(() => {
			order.push("interval");
		});
		hot.disposers.push(() => {
			order.push("server");
		});
		await disposePrevious(hot);
		// Reverse of registration: the server stops before the pool it
		// was answering requests out of closes.
		expect(order).toEqual(["server", "interval", "pool"]);
	});

	test("a disposer that throws does not stop the rest", async () => {
		const closed: string[] = [];
		const hot = state();
		hot.disposers.push(() => {
			closed.push("pool");
		});
		hot.disposers.push(() => {
			throw new Error("socket already gone");
		});
		hot.disposers.push(async () => {
			closed.push("adapters");
		});
		await disposePrevious(hot);
		expect(closed).toEqual(["adapters", "pool"]);
	});

	test("the list is drained, so a second reload does not double-close", async () => {
		let closes = 0;
		const hot = state();
		hot.disposers.push(() => {
			closes += 1;
		});
		await disposePrevious(hot);
		await disposePrevious(hot);
		expect(closes).toBe(1);
		expect(hot.disposers).toHaveLength(0);
	});
});
