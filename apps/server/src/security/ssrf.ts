import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF policy (docs/spec/auth-and-hardening.md): target hostnames are
 * resolved and every returned address is classified before the server
 * opens a connection. Private/loopback/link-local/reserved ranges are
 * blocked unless the hostname matches the deployment allowlist.
 */

export class SsrfBlockedError extends Error {
	readonly code = "SSRF_BLOCKED";

	constructor(host: string, address: string) {
		super(
			`Target host '${host}' is blocked by the SSRF policy (resolves to ${address})`,
		);
		this.name = "SsrfBlockedError";
	}
}

export interface SsrfPolicy {
	assertHostAllowed: (host: string) => Promise<void>;
}

function isBlockedV4(octets: number[]): boolean {
	const [a, b] = octets as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 0) return true; // IETF protocol assignments / TEST-NET-1
	if (a === 192 && b === 168) return true; // private
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
	if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
	if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3
	if (a >= 224) return true; // multicast + reserved
	return false;
}

function isBlockedV6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::1" || normalized === "::") return true;
	if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::"))
		return true;
	// ULA fc00::/7
	if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
	// multicast ff00::/8
	if (normalized.startsWith("ff")) return true;
	// documentation 2001:db8::/32
	if (normalized.startsWith("2001:db8:") || normalized.startsWith("2001:db8::"))
		return true;
	// v4-mapped ::ffff:a.b.c.d — classify the embedded v4 address
	const mapped = /^(?:::{1,2}f{4}|(?:0+:){5}ffff):(\d+\.\d+\.\d+\.\d+)$/.exec(
		normalized,
	);
	if (mapped?.[1] !== undefined) {
		return isBlockedV4(mapped[1].split(".").map(Number));
	}
	return false;
}

function parseV4(address: string): number[] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map(Number);
	return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
		? octets
		: null;
}

export function isBlockedAddress(address: string): boolean {
	const v4 = parseV4(address);
	if (v4 !== null) {
		return isBlockedV4(v4);
	}
	if (address.includes(":")) {
		return isBlockedV6(address);
	}
	// Unparseable → fail closed.
	return true;
}

export function createSsrfPolicy(
	allowlistEnv: string,
	disabled = false,
): SsrfPolicy {
	const allowlist = allowlistEnv
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);

	function isAllowlisted(host: string): boolean {
		const normalized = host.toLowerCase();
		return allowlist.some((entry) => {
			if (entry.startsWith("*.")) {
				return (
					normalized.endsWith(entry.slice(1)) &&
					normalized.length > entry.length - 1
				);
			}
			return normalized === entry;
		});
	}

	return {
		async assertHostAllowed(host) {
			if (disabled) {
				return;
			}
			if (isAllowlisted(host)) {
				return;
			}
			// IP literals skip DNS; anything else resolves first.
			if (isIP(host) !== 0) {
				if (isBlockedAddress(host)) {
					throw new SsrfBlockedError(host, host);
				}
				return;
			}
			let addresses: Array<{ address: string }>;
			try {
				addresses = await lookup(host, { all: true });
			} catch {
				// DNS failure is not an SSRF decision; let the connection
				// attempt report the real error.
				return;
			}
			for (const { address } of addresses) {
				if (isBlockedAddress(address)) {
					throw new SsrfBlockedError(host, address);
				}
			}
		},
	};
}
