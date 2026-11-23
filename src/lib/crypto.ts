/** Password hashing (scrypt) and opaque token helpers — Node built-ins only. */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scrypt(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
			err ? reject(err) : resolve(key),
		),
	);
}

/** Returns a self-describing hash: `scrypt$N$r$p$<salt b64>$<key b64>`. */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
	return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, N, r, p, salt, key] = stored.split("$");
	if (scheme !== "scrypt" || !salt || !key) return false;
	const expected = Buffer.from(key, "base64");
	const actual = await derive(password, Buffer.from(salt, "base64"), Number(N), Number(r), Number(p), expected.length);
	return timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** A hash to compare against when the user doesn't exist, so login timing doesn't reveal accounts. */
export function dummyPasswordHash(): Promise<string> {
	dummy ??= hashPassword(randomBytes(16).toString("hex"));
	return dummy;
}

/** URL-safe random token with an optional readable prefix (e.g. `nvp_` for API tokens). */
export function randomToken(bytes = 32, prefix = ""): string {
	return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

/** Tokens are stored hashed so a leaked database can't be replayed as sessions. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function hmacSha512Hex(secret: string, payload: string | Buffer): string {
	return createHmac("sha512", secret).update(payload).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}
