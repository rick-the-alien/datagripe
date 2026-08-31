import { describe, expect, test } from "bun:test";
import { createDebouncer } from "./debounce";

/** Deterministic timer driver injected into the debouncer — no wall clock. */
function createManualTimers() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; task: () => void }>();

	const set = ((task: () => void, delayMs = 0) => {
		const id = nextId++;
		timers.set(id, { at: now + delayMs, task });
		return id;
	}) as unknown as typeof setTimeout;

	const clear = ((id: number) => {
		timers.delete(id);
	}) as unknown as typeof clearTimeout;

	const advance = (ms: number): void => {
		now += ms;
		for (;;) {
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.at <= now)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) {
				return;
			}
			timers.delete(due[0]);
			due[1].task();
		}
	};

	return { set, clear, advance };
}

describe("createDebouncer", () => {
	test("runs a scheduled task after the delay", () => {
		const timers = createManualTimers();
		const debouncer = createDebouncer(timers.set, timers.clear);
		let ran = 0;
		debouncer.schedule("a", () => ran++, 10);
		expect(debouncer.pending("a")).toBe(true);
		timers.advance(9);
		expect(ran).toBe(0);
		timers.advance(1);
		expect(ran).toBe(1);
		expect(debouncer.pending("a")).toBe(false);
	});

	test("rescheduling replaces the pending task (trailing edge)", () => {
		const timers = createManualTimers();
		const debouncer = createDebouncer(timers.set, timers.clear);
		const calls: string[] = [];
		debouncer.schedule("a", () => calls.push("first"), 10);
		timers.advance(5);
		debouncer.schedule("a", () => calls.push("second"), 10);
		timers.advance(10);
		expect(calls).toEqual(["second"]);
	});

	test("keys are independent", () => {
		const timers = createManualTimers();
		const debouncer = createDebouncer(timers.set, timers.clear);
		const calls: string[] = [];
		debouncer.schedule("a", () => calls.push("a"), 10);
		debouncer.schedule("b", () => calls.push("b"), 10);
		debouncer.cancel("a");
		timers.advance(20);
		expect(calls).toEqual(["b"]);
	});

	test("flush(key) runs the pending task immediately, once", () => {
		const timers = createManualTimers();
		const debouncer = createDebouncer(timers.set, timers.clear);
		let ran = 0;
		debouncer.schedule("a", () => ran++, 10_000);
		debouncer.flush("a");
		expect(ran).toBe(1);
		timers.advance(20_000);
		expect(ran).toBe(1);
	});

	test("flush() with no key drains every pending task", () => {
		const timers = createManualTimers();
		const debouncer = createDebouncer(timers.set, timers.clear);
		const calls: string[] = [];
		debouncer.schedule("a", () => calls.push("a"), 10_000);
		debouncer.schedule("b", () => calls.push("b"), 10_000);
		debouncer.flush();
		expect(calls.sort()).toEqual(["a", "b"]);
	});
});
