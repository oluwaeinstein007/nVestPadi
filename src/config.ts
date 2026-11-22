/**
 * Application configuration — the single place that reads `process.env`.
 *
 * Every variable is optional: with no configuration at all, nVestPadi still
 * syncs market data, runs technical analysis, screens and alerts. AI features
 * (search, ask, document ingestion) light up once an AI provider and Qdrant
 * are configured. See `.env.example` for documentation of each variable.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type AIProviderName = "openai" | "gemini";

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

export interface Config {
	env: "development" | "production" | "test";
	logLevel: "debug" | "info" | "warn" | "error";
	databasePath: string;
	ai: AIConfig | null;
	qdrant: QdrantConfig | null;
	markets: { usSymbols: string[] };
	server: { host: string; port: number; apiKey?: string };
	notifications: {
		telegram: { botToken: string; chatId: string } | null;
		discordWebhookUrl: string | null;
	};
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

const EnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
		LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
		DATABASE_PATH: z.string().default("data/nvestpadi.db"),

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
		API_KEY: z.string().optional(),

		TELEGRAM_BOT_TOKEN: z.string().optional(),
		TELEGRAM_CHAT_ID: z.string().optional(),
		DISCORD_WEBHOOK_URL: z.string().url().optional(),
	})
	.superRefine((env, ctx) => {
		if (env.AI_PROVIDER && !env.AI_API_KEY) {
			ctx.addIssue({
				code: "custom",
				path: ["AI_API_KEY"],
				message: `required when AI_PROVIDER=${env.AI_PROVIDER}`,
			});
		}
		if (Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_CHAT_ID)) {
			ctx.addIssue({
				code: "custom",
				path: ["TELEGRAM_CHAT_ID"],
				message: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together",
			});
		}
	});

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

	return {
		env: env.NODE_ENV,
		logLevel: env.LOG_LEVEL,
		databasePath: env.DATABASE_PATH === ":memory:" ? env.DATABASE_PATH : path.resolve(env.DATABASE_PATH),
		ai,
		qdrant: env.QDRANT_URL
			? {
					url: env.QDRANT_URL,
					apiKey: env.QDRANT_API_KEY,
					collection: env.QDRANT_COLLECTION,
				}
			: null,
		markets: { usSymbols },
		server: { host: env.HOST, port: env.PORT, apiKey: env.API_KEY },
		notifications: {
			telegram:
				env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
					? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
					: null,
			discordWebhookUrl: env.DISCORD_WEBHOOK_URL ?? null,
		},
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
