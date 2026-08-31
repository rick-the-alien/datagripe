import { describe, expect, test } from "bun:test";
import { createSsrfPolicy, isBlockedAddress } from "./ssrf";

describe("isBlockedAddress", () => {
	test("blocks loopback, private, link-local, CGNAT, multicast, reserved", () => {
		for (const address of [
			"127.0.0.1",
			"127.5.3.2",
			"10.0.0.4",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"240.1.2.3",
			"192.0.2.10",
			"198.51.100.7",
			"203.0.113.9",
		]) {
			expect(isBlockedAddress(address)).toBe(true);
		}
	});

	test("allows public addresses", () => {
		for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "203.0.114.1"]) {
			expect(isBlockedAddress(address)).toBe(false);
		}
	});

	test("blocks IPv6 loopback, link-local, ULA, multicast, v4-mapped private", () => {
		expect(isBlockedAddress("::1")).toBe(true);
		expect(isBlockedAddress("fe80::1")).toBe(true);
		expect(isBlockedAddress("fc00::1")).toBe(true);
		expect(isBlockedAddress("fd12:3456::1")).toBe(true);
		expect(isBlockedAddress("ff02::1")).toBe(true);
		expect(isBlockedAddress("2001:db8::1")).toBe(true);
		expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isBlockedAddress("::ffff:192.168.0.5")).toBe(true);
	});

	test("allows public IPv6", () => {
		expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
	});

	test("unparseable input fails closed", () => {
		expect(isBlockedAddress("not-an-ip")).toBe(true);
	});
});

describe("ssrf policy", () => {
	test("blocks IP literals without DNS", async () => {
		const policy = createSsrfPolicy("");
		await expect(policy.assertHostAllowed("127.0.0.1")).rejects.toThrow("SSRF");
		await policy.assertHostAllowed("8.8.8.8");
	});

	test("allowlist overrides blocks, exact and wildcard", async () => {
		const policy = createSsrfPolicy("localhost,127.0.0.1,*.internal.example");
		await policy.assertHostAllowed("localhost");
		await policy.assertHostAllowed("127.0.0.1");
		await policy.assertHostAllowed("db.internal.example");
		await expect(policy.assertHostAllowed("192.168.0.1")).rejects.toThrow(
			"SSRF",
		);
	});

	test("resolves localhost to a blocked address by default", async () => {
		const policy = createSsrfPolicy("");
		await expect(policy.assertHostAllowed("localhost")).rejects.toThrow("SSRF");
	});
});
