import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rateLimit";

const SPECS = {
	"auth.login": { capacity: 3, refillPerMinute: 6 },
};

describe("rate limiter", () => {
	test("allows up to capacity, then rejects", () => {
		const limiter = createRateLimiter(SPECS);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(false);
		limiter.stop();
	});

	test("subjects are independent", () => {
		const limiter = createRateLimiter(SPECS);
		for (let i = 0; i < 3; i++) limiter.take("auth.login", "ip:1");
		expect(limiter.take("auth.login", "ip:2")).toBe(true);
		limiter.stop();
	});

	test("tokens refill over time", () => {
		let at = 1_000_000;
		const limiter = createRateLimiter(SPECS, () => at);
		for (let i = 0; i < 3; i++) limiter.take("auth.login", "ip:1");
		expect(limiter.take("auth.login", "ip:1")).toBe(false);
		at += 10_000; // one minute's worth of a token at 6/min
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		limiter.stop();
	});

	test("refill never exceeds capacity", () => {
		let at = 1_000_000;
		const limiter = createRateLimiter(SPECS, () => at);
		at += 60 * 60_000;
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(false);
		limiter.stop();
	});

	test("unknown scopes are unlimited", () => {
		const limiter = createRateLimiter(SPECS);
		for (let i = 0; i < 100; i++) {
			expect(limiter.take("unknown.scope", "x")).toBe(true);
		}
		limiter.stop();
	});

	test("sweep drops stale buckets", () => {
		let at = 1_000_000;
		const limiter = createRateLimiter(SPECS, () => at);
		limiter.take("auth.login", "ip:1");
		at += 2 * 60 * 60_000;
		limiter.sweep();
		// Bucket reaped → full capacity again.
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		expect(limiter.take("auth.login", "ip:1")).toBe(true);
		limiter.stop();
	});
});
