import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";

/**
 * Connection-secret encryption (docs/initial_idea.md §12): AES-256-GCM
 * with a versioned key ring. The master material comes from deployment
 * configuration, never from the database; each stored ciphertext carries
 * its key version so keys can rotate.
 *
 * Ciphertext layout: iv (12 bytes) ‖ ciphertext ‖ auth tag (16 bytes).
 */

export interface EncryptedSecret {
	ciphertext: Buffer;
	keyVersion: number;
}

export interface SecretKeyring {
	readonly activeVersion: number;
	encrypt: (plaintext: string) => EncryptedSecret;
	decrypt: (ciphertext: Buffer, keyVersion: number) => string;
}

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function deriveKey(material: string, version: number): Buffer {
	// SHA-256 domain-separated derivation: a 32-byte AES key from arbitrary-
	// length deployment material, stable across restarts.
	return createHash("sha256")
		.update(`datagripe-connection-secrets:v${version}:${material}`)
		.digest();
}

export class UnknownKeyVersionError extends Error {
	constructor(version: number) {
		super(`No connection-secret key for version ${version}`);
		this.name = "UnknownKeyVersionError";
	}
}

/**
 * Build a key ring from versioned master material. The highest version is
 * active for encryption; every provided version can decrypt.
 */
export function createKeyring(
	materialsByVersion: ReadonlyMap<number, string>,
): SecretKeyring {
	if (materialsByVersion.size === 0) {
		throw new Error("Connection-secret keyring requires at least one key");
	}
	const keys = new Map<number, Buffer>();
	for (const [version, material] of materialsByVersion) {
		keys.set(version, deriveKey(material, version));
	}
	const activeVersion = Math.max(...keys.keys());

	return {
		activeVersion,

		encrypt(plaintext) {
			const key = keys.get(activeVersion);
			if (key === undefined) {
				throw new UnknownKeyVersionError(activeVersion);
			}
			const iv = randomBytes(IV_LENGTH);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const encrypted = Buffer.concat([
				cipher.update(plaintext, "utf8"),
				cipher.final(),
			]);
			return {
				ciphertext: Buffer.concat([iv, encrypted, cipher.getAuthTag()]),
				keyVersion: activeVersion,
			};
		},

		decrypt(ciphertext, keyVersion) {
			const key = keys.get(keyVersion);
			if (key === undefined) {
				throw new UnknownKeyVersionError(keyVersion);
			}
			if (ciphertext.length < IV_LENGTH + TAG_LENGTH) {
				throw new Error("Ciphertext too short");
			}
			const iv = ciphertext.subarray(0, IV_LENGTH);
			const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
			const body = ciphertext.subarray(
				IV_LENGTH,
				ciphertext.length - TAG_LENGTH,
			);
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(body), decipher.final()]).toString(
				"utf8",
			);
		},
	};
}
