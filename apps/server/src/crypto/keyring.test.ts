import { describe, expect, test } from "bun:test";
import { createKeyring } from "./keyring";

const MATERIAL_V1 = "test-master-key-material-0123456789";
const MATERIAL_V2 = "rotated-master-key-material-abcdef";

describe("keyring", () => {
	test("encrypt/decrypt round trip", () => {
		const keyring = createKeyring(new Map([[1, MATERIAL_V1]]));
		const secret = "p@ssw0rd-with-ünïcode-✓";
		const encrypted = keyring.encrypt(secret);
		expect(encrypted.keyVersion).toBe(1);
		expect(encrypted.ciphertext.toString("utf8")).not.toContain(secret);
		expect(keyring.decrypt(encrypted.ciphertext, 1)).toBe(secret);
	});

	test("ciphertexts differ across encryptions (random IV)", () => {
		const keyring = createKeyring(new Map([[1, MATERIAL_V1]]));
		const a = keyring.encrypt("same-secret");
		const b = keyring.encrypt("same-secret");
		expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
		expect(keyring.decrypt(a.ciphertext, 1)).toBe("same-secret");
		expect(keyring.decrypt(b.ciphertext, 1)).toBe("same-secret");
	});

	test("tampered ciphertext fails authentication", () => {
		const keyring = createKeyring(new Map([[1, MATERIAL_V1]]));
		const encrypted = keyring.encrypt("secret");
		const tampered = Buffer.from(encrypted.ciphertext);
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
		expect(() => keyring.decrypt(tampered, 1)).toThrow();
	});

	test("wrong key material fails authentication", () => {
		const writer = createKeyring(new Map([[1, MATERIAL_V1]]));
		const reader = createKeyring(new Map([[1, "other-material-0123456789ab"]]));
		const encrypted = writer.encrypt("secret");
		expect(() => reader.decrypt(encrypted.ciphertext, 1)).toThrow();
	});

	test("older versions stay decryptable after rotation; new writes use the active version", () => {
		const before = createKeyring(new Map([[1, MATERIAL_V1]]));
		const legacy = before.encrypt("legacy-secret");

		const rotated = createKeyring(
			new Map([
				[1, MATERIAL_V1],
				[2, MATERIAL_V2],
			]),
		);
		expect(rotated.activeVersion).toBe(2);
		expect(rotated.decrypt(legacy.ciphertext, legacy.keyVersion)).toBe(
			"legacy-secret",
		);
		const fresh = rotated.encrypt("fresh-secret");
		expect(fresh.keyVersion).toBe(2);
		expect(rotated.decrypt(fresh.ciphertext, 2)).toBe("fresh-secret");
	});

	test("unknown key version is a named error", () => {
		const keyring = createKeyring(new Map([[1, MATERIAL_V1]]));
		const encrypted = keyring.encrypt("secret");
		expect(() => keyring.decrypt(encrypted.ciphertext, 99)).toThrow(
			"No connection-secret key for version 99",
		);
	});

	test("empty keyring is rejected", () => {
		expect(() => createKeyring(new Map())).toThrow();
	});
});
