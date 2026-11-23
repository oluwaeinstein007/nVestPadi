/**
 * Transactional email. Uses Resend's REST API when RESEND_API_KEY is set;
 * otherwise messages (including verification and reset links) are written to
 * the server log, which is enough for a self-hosted server with one owner.
 */
import type { Config } from "../config.js";
import { postJson } from "../lib/http.js";
import { logger } from "../lib/logger.js";

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

export interface Mailer {
	readonly name: string;
	/** False when messages only go to the log, i.e. nobody can click a link in them. */
	readonly delivers: boolean;
	send(message: EmailMessage): Promise<void>;
}

class ResendMailer implements Mailer {
	readonly name = "resend";
	readonly delivers = true;
	constructor(private readonly config: NonNullable<Config["email"]>) {}

	async send(message: EmailMessage) {
		await postJson(
			"https://api.resend.com/emails",
			{ from: this.config.from, to: [message.to], subject: message.subject, text: message.text, html: message.html },
			{ headers: { Authorization: `Bearer ${this.config.resendApiKey}` }, retries: 1 },
		);
	}
}

class LogMailer implements Mailer {
	readonly name = "log";
	readonly delivers = false;

	async send(message: EmailMessage) {
		logger.info(`email (not sent — no RESEND_API_KEY) to ${message.to}: ${message.subject}\n${message.text}`);
	}
}

export function createMailer(config: Config["email"]): Mailer {
	return config ? new ResendMailer(config) : new LogMailer();
}
