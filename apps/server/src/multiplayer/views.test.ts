import { describe, expect, test } from "bun:test";
import { ViewBroadcastThrottle } from "./views";

describe("ViewBroadcastThrottle", () => {
	test("allows at most 4 Hz per user, then again after the interval", () => {
		let now = 1_000_000;
		const throttle = new ViewBroadcastThrottle(() => now);
		expect(throttle.allow("u1")).toBe(true);
		expect(throttle.allow("u1")).toBe(false);
		expect(throttle.allow("u2")).toBe(true);
		now += 249;
		expect(throttle.allow("u1")).toBe(false);
		now += 1;
		expect(throttle.allow("u1")).toBe(true);
	});
});
