/**
 * fetch wrapper with timeouts, retries (network errors, 429, 5xx) and
 * exponential backoff that honours `Retry-After`.
 */
import { logger } from "./logger.js";

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly url: string,
		public readonly body?: string,
	) {
		super(`HTTP ${status} from ${redact(url)}`);
		this.name = "HttpError";
	}
}

export interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
	retries?: number;
}

// Yahoo Finance rejects full browser UA strings from non-browsers but accepts this.
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; nVestPadi/2.0)";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Strip credentials from URLs before they reach logs or error messages. */
function redact(url: string): string {
	return url
		.replace(/([?&](key|token|api_key)=)[^&]+/gi, "$1***")
		.replace(/\/bot[^/]+\//, "/bot***/") // Telegram
		.replace(/(\/webhooks\/\d+\/)[^/?]+/, "$1***"); // Discord
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500;
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
	const { method = "GET", timeoutMs = 20_000, retries = 2 } = options;
	const headers: Record<string, string> = {
		"User-Agent": DEFAULT_USER_AGENT,
		...options.headers,
	};
	let body: string | undefined;
	if (options.body !== undefined) {
		body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
		headers["Content-Type"] ??= "application/json";
	}

	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(timeoutMs),
				redirect: "follow",
			});
		} catch (err) {
			if (attempt >= retries) throw err;
			await backoff(attempt, url, err instanceof Error ? err.message : "network error");
			continue;
		}

		if (response.ok) return response;

		const text = await response.text().catch(() => "");
		if (!isRetryable(response.status) || attempt >= retries) {
			throw new HttpError(response.status, url, text.slice(0, 2000));
		}
		const retryAfter = Number(response.headers.get("retry-after"));
		await backoff(attempt, url, `HTTP ${response.status}`, retryAfter > 0 ? retryAfter * 1000 : undefined);
	}
}

async function backoff(attempt: number, url: string, reason: string, overrideMs?: number) {
	const delay = overrideMs ?? 500 * 2 ** attempt + Math.random() * 250;
	logger.debug("retrying request", { url: redact(url), reason, delayMs: Math.round(delay) });
	await sleep(Math.min(delay, 10_000));
}

export async function getJson<T = unknown>(url: string, options?: RequestOptions): Promise<T> {
	const response = await request(url, {
		...options,
		headers: { Accept: "application/json", ...options?.headers },
	});
	return (await response.json()) as T;
}

export async function getText(url: string, options?: RequestOptions): Promise<string> {
	const response = await request(url, options);
	return response.text();
}

export async function postJson<T = unknown>(
	url: string,
	body: unknown,
	options?: Omit<RequestOptions, "body" | "method">,
): Promise<T> {
	const response = await request(url, {
		...options,
		method: "POST",
		body,
		headers: { Accept: "application/json", ...options?.headers },
	});
	const text = await response.text();
	return (text ? JSON.parse(text) : undefined) as T;
}
