/**
 * Discord: channel webhooks for digests and an HTTP interactions endpoint for
 * slash commands (no gateway connection needed). Requests from Discord are
 * verified with the application's Ed25519 public key.
 */
import { createPublicKey, verify } from "node:crypto";
import { request } from "../lib/http.js";

const API = "https://discord.com/api/v10";
/** DER prefix that wraps a raw 32-byte Ed25519 key as SPKI. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_MESSAGE = 1900;

export const InteractionType = { Ping: 1, Command: 2 } as const;
export const ResponseType = { Pong: 1, Message: 4, Deferred: 5 } as const;

export interface Interaction {
	type: number;
	token: string;
	application_id: string;
	data?: { name: string; options?: { name: string; value: string | number | boolean }[] };
	guild_id?: string;
	channel_id?: string;
	member?: { user?: { id: string } };
	user?: { id: string };
}

export function verifyDiscordRequest(
	publicKeyHex: string,
	signatureHex: string | undefined,
	timestamp: string | undefined,
	rawBody: Buffer,
): boolean {
	if (!signatureHex || !timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
	try {
		const key = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
			format: "der",
			type: "spki",
		});
		return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signatureHex, "hex"));
	} catch {
		return false;
	}
}

const clip = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s);

/** Post to a channel webhook (digests, alerts). Mentions are disabled. */
export async function postDiscordWebhook(url: string, content: string) {
	await request(url, { method: "POST", body: { content: clip(content), allowed_mentions: { parse: [] } } });
}

/** Replace the "thinking…" placeholder of a deferred interaction. */
export async function editInteractionResponse(applicationId: string, token: string, content: string) {
	await request(`${API}/webhooks/${applicationId}/${token}/messages/@original`, {
		method: "PATCH",
		body: { content: clip(content), allowed_mentions: { parse: [] } },
	});
}

/** Register (overwrite) the global slash commands. */
export async function registerDiscordCommands(
	applicationId: string,
	botToken: string,
	commands: { name: string; description: string; options?: unknown[] }[],
) {
	await request(`${API}/applications/${applicationId}/commands`, {
		method: "PUT",
		headers: { Authorization: `Bot ${botToken}` },
		body: commands,
	});
}
