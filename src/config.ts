/**
 * Application configuration — the single place that reads `process.env`.
 *
 * Every variable is optional: with no configuration at all, nVestPadi runs as
 * a self-hosted app that syncs market data, analyzes, screens and alerts.
 * AI, email delivery and billing light up as their variables are set.
 * See `.env.example` for documentation of each variable.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type AIProviderName = "openai" | "gemini";

/**
 * `cloud`: the hosted product — open sign-up, Free/Pro plans and billing.
 * `self-hosted`: your own server — the first account is the owner, every
 * feature is unlimited and sign-up closes once the owner exists.
 */
export type AppMode = "cloud" | "self-hosted";

export interface AIConfig {
	provider: AIProviderName;
	apiKey: string;
	chatModel: string;
	embeddingModel: string;
	/** Requested embedding size; undefined means the model's native size. */
	embeddingDimensions?: number;
}

export interface QdrantConfig {
	url: string;
	apiKey?: string;
	collection: string;
}

/** Where data lives: a local SQLite file (default) or a PostgreSQL server. */
export type DatabaseConfig =
	| { kind: "sqlite"; path: string }
	| { kind: "postgres"; url: string; caCert?: string; poolMax: number };

/** Human-readable location for logs and `nvest doctor`, never including the password. */
export function describeDatabase(db: DatabaseConfig): string {
	if (db.kind === "sqlite") return `SQLite ${db.path}`;
	const url = new URL(db.url);
	return `PostgreSQL ${url.username ? `${decodeURIComponent(url.username)}@` : ""}${url.host}${url.pathname}`;
}

const isPostgresUrl = (value: string) => /^postgres(ql)?:\/\//i.test(value);

export interface Config {
	env: "development" | "production" | "test";
	mode: AppMode;
	logLevel: "debug" | "info" | "warn" | "error";
	/** Public base URL, used in emails and payment redirects (no trailing slash). */
	appUrl: string;
	database: DatabaseConfig;
	ai: AIConfig | null;
	qdrant: QdrantConfig | null;
	markets: { usSymbols: string[] };
	server: { host: string; port: number; trustProxy: boolean };
	auth: {
		/** null = the mode's default (cloud: open; self-hosted: only until the owner exists). */
		allowSignup: boolean | null;
		secureCookies: boolean;
	};
	email: { resendApiKey: string; from: string } | null;
	billing: { paystackSecretKey: string; planCode: string } | null;
	/** Server-wide Telegram bot: answers commands and posts daily market digests to `broadcastChatId`. */
	telegram: { botToken: string; broadcastChatId: string | null; webhookSecret: string | null } | null;
	discord: {
		/** Channel webhook for daily market digests. */
		broadcastWebhookUrl: string | null;
		/** Slash-command app (interactions endpoint); null when not configured. */
		app: { applicationId: string; publicKey: string; botToken: string | null } | null;
	};
	/** Send daily market digests to broadcast channels and personal digests to users. */
	digests: boolean;
	/** While a market is open, re-sync it this often (minutes); 0 = only the regular sync. */
	liveSyncMinutes: number;
	coingeckoApiKey: string | null;
	/** Non-fatal problems, e.g. variables from older versions that are now ignored. */
	warnings: string[];
}

export const DEFAULT_MODELS: Record<AIProviderName, { chat: string; embedding: string }> = {
	openai: { chat: "gpt-4.1-mini", embedding: "text-embedding-3-small" },
	gemini: { chat: "gemini-2.5-flash", embedding: "gemini-embedding-001" },
};

/** Top 30 S&P 500 constituents by market cap — used when US_SYMBOLS is unset. */
export const DEFAULT_US_SYMBOLS = [
	"AAPL",
	"MSFT",
	"NVDA",
	"AMZN",
	"GOOGL",
	"META",
	"BRK-B",
	"LLY",
	"JPM",
	"V",
	"UNH",
	"XOM",
	"TSLA",
	"MA",
	"PG",
	"JNJ",
	"HD",
	"AVGO",
	"MRK",
	"CVX",
	"ABBV",
	"COST",
	"AMD",
	"CRM",
	"NFLX",
	"BAC",
	"PEP",
	"KO",
	"TMO",
	"WMT",
];

const bool = z
	.enum(["true", "false", "1", "0", "yes", "no"])
	.transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
		APP_MODE: z.enum(["cloud", "self-hosted"]).default("self-hosted"),
		APP_URL: z.string().url().optional(),
		LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
		DATABASE_PATH: z.string().default("data/nvestpadi.db"),
		DATABASE_URL: z
			.string()
			.refine(
				isPostgresUrl,
				"must be a PostgreSQL URL (postgres://user:password@host:5432/dbname); for SQLite use DATABASE_PATH",
			)
			.optional(),
		/** For hosts that hand out the URL and the password separately. Only used when the URL has no password. */
		DATABASE_PASSWORD: z.string().optional(),
		DATABASE_CA_CERT: z.string().optional(),
		DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

		AI_PROVIDER: z.enum(["openai", "gemini"]).optional(),
		AI_API_KEY: z.string().optional(),
		AI_CHAT_MODEL: z.string().optional(),
		AI_EMBEDDING_MODEL: z.string().optional(),
		AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),

		QDRANT_URL: z.string().url().optional(),
		QDRANT_API_KEY: z.string().optional(),
		QDRANT_COLLECTION: z
			.string()
			.regex(/^[\w-]+$/, "letters, digits, '-' and '_' only")
			.default("nvestpadi"),

		US_SYMBOLS: z.string().optional(),

		HOST: z.string().default("127.0.0.1"),
		PORT: z.coerce.number().int().min(1).max(65535).default(3000),
		TRUST_PROXY: bool.default("false"),
		ALLOW_SIGNUP: bool.optional(),

		RESEND_API_KEY: z.string().optional(),
		EMAIL_FROM: z.string().optional(),

		PAYSTACK_SECRET_KEY: z.string().optional(),
		PAYSTACK_PLAN_CODE: z.string().optional(),

		TELEGRAM_BOT_TOKEN: z.string().optional(),
		TELEGRAM_CHAT_ID: z.string().optional(),
		TELEGRAM_WEBHOOK_SECRET: z
			.string()
			.regex(/^[\w-]{16,256}$/, "16–256 letters, digits, '_' or '-'")
			.optional(),
		DISCORD_WEBHOOK_URL: z.string().url().optional(),
		DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/, "numeric application id").optional(),
		DISCORD_PUBLIC_KEY: z
			.string()
			.regex(/^[0-9a-f]{64}$/i, "64 hex characters")
			.optional(),
		DISCORD_BOT_TOKEN: z.string().optional(),
		DAILY_DIGEST: bool.default("true"),
		LIVE_SYNC_MINUTES: z.coerce.number().int().min(0).max(240).default(5),
		COINGECKO_API_KEY: z.string().optional(),
	})
	.superRefine((env, ctx) => {
		if (env.AI_PROVIDER && !env.AI_API_KEY) {
			ctx.addIssue({
				code: "custom",
				path: ["AI_API_KEY"],
				message: `required when AI_PROVIDER=${env.AI_PROVIDER}`,
			});
		}
		if (Boolean(env.PAYSTACK_SECRET_KEY) !== Boolean(env.PAYSTACK_PLAN_CODE)) {
			ctx.addIssue({
				code: "custom",
				path: ["PAYSTACK_PLAN_CODE"],
				message: "PAYSTACK_SECRET_KEY and PAYSTACK_PLAN_CODE must be set together",
			});
		}
		if (env.RESEND_API_KEY && !env.EMAIL_FROM) {
			ctx.addIssue({
				code: "custom",
				path: ["EMAIL_FROM"],
				message: 'required when RESEND_API_KEY is set, e.g. "nVestPadi <hello@yourdomain.com>"',
			});
		}
		if (env.TELEGRAM_CHAT_ID && !env.TELEGRAM_BOT_TOKEN) {
			ctx.addIssue({ code: "custom", path: ["TELEGRAM_BOT_TOKEN"], message: "required when TELEGRAM_CHAT_ID is set" });
		}
		if (Boolean(env.DISCORD_APPLICATION_ID) !== Boolean(env.DISCORD_PUBLIC_KEY)) {
			ctx.addIssue({
				code: "custom",
				path: ["DISCORD_PUBLIC_KEY"],
				message: "DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY must be set together",
			});
		}
		if (env.APP_MODE === "cloud" && env.NODE_ENV === "production" && !env.APP_URL) {
			ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "required in production cloud mode" });
		}
	});

/** Variables from v2.0 that no longer do anything, with what replaced them. */
const REMOVED_VARIABLES: Record<string, string> = {
	API_KEY: "sign in with an account; create personal API tokens under Settings → API tokens",
};

export class ConfigError extends Error {
	constructor(public readonly issues: string[]) {
		super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
		this.name = "ConfigError";
	}
}

/** Build a Config from an env map. Pure — safe to call from tests. */
export function parseConfig(source: NodeJS.ProcessEnv): Config {
	// Treat blank values (`KEY=`) as unset so `.env.example` can be copied verbatim.
	const cleaned: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		const trimmed = value?.trim();
		if (trimmed) cleaned[key] = trimmed;
	}

	const result = EnvSchema.safeParse(cleaned);
	if (!result.success) {
		throw new ConfigError(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
	}
	const env = result.data;

	const ai: AIConfig | null =
		env.AI_PROVIDER && env.AI_API_KEY
			? {
					provider: env.AI_PROVIDER,
					apiKey: env.AI_API_KEY,
					chatModel: env.AI_CHAT_MODEL ?? DEFAULT_MODELS[env.AI_PROVIDER].chat,
					embeddingModel: env.AI_EMBEDDING_MODEL ?? DEFAULT_MODELS[env.AI_PROVIDER].embedding,
					embeddingDimensions: env.AI_EMBEDDING_DIMENSIONS,
				}
			: null;

	const usSymbols = env.US_SYMBOLS
		? env.US_SYMBOLS.split(",")
				.map((s) => s.trim().toUpperCase())
				.filter(Boolean)
		: DEFAULT_US_SYMBOLS;

	const appUrl = (env.APP_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");
	const warnings = Object.entries(REMOVED_VARIABLES)
		.filter(([key]) => cleaned[key])
		.map(([key, instead]) => `${key} is no longer used — ${instead}.`);

	// `.invalid` never resolves, so every emailed link (verify, reset) would be dead. staging.env ships one as a placeholder.
	if (env.APP_URL && /^https?:\/\/[^/]*\.invalid(?::\d+)?(\/|$)/i.test(env.APP_URL)) {
		warnings.push(
			`APP_URL (${env.APP_URL}) is a placeholder host — emailed links (verify email, password reset) will not open. Set it to this deployment's real public URL and redeploy.`,
		);
	}

	// DATABASE_URL wins. A PostgreSQL URL in DATABASE_PATH is an easy mistake, so honour it and say what to change.
	let postgresUrl = env.DATABASE_URL;
	if (!postgresUrl && isPostgresUrl(env.DATABASE_PATH)) {
		postgresUrl = env.DATABASE_PATH;
		warnings.push(
			"DATABASE_PATH holds a PostgreSQL URL — move it to DATABASE_URL (DATABASE_PATH is for SQLite files).",
		);
	}
	if (postgresUrl && env.DATABASE_PASSWORD) {
		try {
			const parsed = new URL(postgresUrl);
			if (!parsed.password) {
				parsed.password = env.DATABASE_PASSWORD;
				postgresUrl = parsed.toString();
			}
		} catch {
			// An unparseable URL is reported by the driver.
		}
	}
	const database: DatabaseConfig = postgresUrl
		? {
				kind: "postgres",
				url: postgresUrl,
				// Single-line env vars can't hold newlines, so accept a literal "\n" in the PEM.
				caCert: env.DATABASE_CA_CERT?.replace(/\\n/g, "\n"),
				poolMax: env.DATABASE_POOL_MAX,
			}
		: { kind: "sqlite", path: env.DATABASE_PATH === ":memory:" ? env.DATABASE_PATH : path.resolve(env.DATABASE_PATH) };

	return {
		env: env.NODE_ENV,
		mode: env.APP_MODE,
		logLevel: env.LOG_LEVEL,
		appUrl,
		database,
		ai,
		qdrant: env.QDRANT_URL
			? {
					url: env.QDRANT_URL,
					apiKey: env.QDRANT_API_KEY,
					collection: env.QDRANT_COLLECTION,
				}
			: null,
		markets: { usSymbols },
		server: { host: env.HOST, port: env.PORT, trustProxy: env.TRUST_PROXY },
		auth: { allowSignup: env.ALLOW_SIGNUP ?? null, secureCookies: appUrl.startsWith("https://") },
		email: env.RESEND_API_KEY && env.EMAIL_FROM ? { resendApiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM } : null,
		billing:
			env.PAYSTACK_SECRET_KEY && env.PAYSTACK_PLAN_CODE
				? { paystackSecretKey: env.PAYSTACK_SECRET_KEY, planCode: env.PAYSTACK_PLAN_CODE }
				: null,
		telegram: env.TELEGRAM_BOT_TOKEN
			? {
					botToken: env.TELEGRAM_BOT_TOKEN,
					broadcastChatId: env.TELEGRAM_CHAT_ID ?? null,
					webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
				}
			: null,
		discord: {
			broadcastWebhookUrl: env.DISCORD_WEBHOOK_URL ?? null,
			app:
				env.DISCORD_APPLICATION_ID && env.DISCORD_PUBLIC_KEY
					? {
							applicationId: env.DISCORD_APPLICATION_ID,
							publicKey: env.DISCORD_PUBLIC_KEY,
							botToken: env.DISCORD_BOT_TOKEN ?? null,
						}
					: null,
		},
		digests: env.DAILY_DIGEST,
		liveSyncMinutes: env.LIVE_SYNC_MINUTES,
		coingeckoApiKey: env.COINGECKO_API_KEY ?? null,
		warnings,
	};
}

let cached: Config | undefined;

/** Load `.env` (if present, never overriding real env vars) and parse config once. */
export function loadConfig(envFile = ".env"): Config {
	if (cached) return cached;
	if (existsSync(envFile)) process.loadEnvFile(envFile);
	cached = parseConfig(process.env);
	return cached;
}
