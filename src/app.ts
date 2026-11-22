/**
 * Composition root: builds every service from config. Shared by the CLI and
 * the HTTP server so both behave identically.
 */
import { type AIProvider, createAIProvider } from "./ai/provider.js";
import type { Config } from "./config.js";
import { errorMessage, logger } from "./lib/logger.js";
import type { Exchange } from "./markets/types.js";
import { AlertService, Notifier, type TriggeredAlert } from "./services/alertService.js";
import { InsightService } from "./services/insightService.js";
import { KnowledgeBase } from "./services/knowledgeBase.js";
import { MarketService, type SyncResult } from "./services/marketService.js";
import { Database } from "./storage/database.js";
import { VectorStore } from "./storage/vectorStore.js";

export interface App {
	config: Config;
	db: Database;
	ai: AIProvider | null;
	vectors: VectorStore | null;
	kb: KnowledgeBase;
	market: MarketService;
	insights: InsightService;
	alerts: AlertService;
	notifier: Notifier;
	/** Sync one or more exchanges, then evaluate alerts. Partial failures are reported, not thrown. */
	syncAndAlert(
		exchanges: Exchange[],
		options?: { symbols?: string[]; index?: boolean },
	): Promise<{ results: SyncResult[]; errors: { exchange: Exchange; error: string }[]; triggered: TriggeredAlert[] }>;
	doctor(): Promise<HealthCheck[]>;
	close(): void;
}

export interface HealthCheck {
	name: string;
	status: "ok" | "warn" | "off" | "error";
	detail: string;
}

export function createApp(config: Config): App {
	const db = new Database(config.databasePath);
	const ai = createAIProvider(config.ai);
	const vectors = config.qdrant ? new VectorStore(config.qdrant) : null;
	const kb = new KnowledgeBase(db, ai, vectors);
	const market = new MarketService(db, kb, config.markets.usSymbols);
	const insights = new InsightService(db, ai, kb, market);
	const notifier = new Notifier(config.notifications);
	const alerts = new AlertService(db, notifier);

	return {
		config,
		db,
		ai,
		vectors,
		kb,
		market,
		insights,
		alerts,
		notifier,

		async syncAndAlert(exchanges, options = {}) {
			const results: SyncResult[] = [];
			const errors: { exchange: Exchange; error: string }[] = [];
			for (const exchange of exchanges) {
				try {
					results.push(await market.sync(exchange, options));
				} catch (err) {
					logger.error(`${exchange} sync failed`, { error: errorMessage(err) });
					errors.push({ exchange, error: errorMessage(err) });
				}
			}
			const triggered = await alerts.check();
			return { results, errors, triggered };
		},

		async doctor() {
			const checks: HealthCheck[] = [];
			const stats = db.stats();
			checks.push({
				name: "Database",
				status: "ok",
				detail: `${config.databasePath} — ${stats.securities} securities, ${stats.prices} price rows${stats.lastPriceDate ? `, latest ${stats.lastPriceDate}` : ""}`,
			});

			if (!ai) {
				checks.push({
					name: "AI provider",
					status: "off",
					detail: "Set AI_PROVIDER and AI_API_KEY to enable ask/search/ingest",
				});
			} else {
				try {
					const [v] = await ai.embed(["health check"], "query");
					checks.push({
						name: "AI provider",
						status: "ok",
						detail: `${ai.name} · chat ${ai.chatModel} · embeddings ${ai.embeddingModel} (${v?.length} dims)`,
					});
				} catch (err) {
					checks.push({ name: "AI provider", status: "error", detail: errorMessage(err) });
				}
			}

			if (!vectors) {
				checks.push({
					name: "Qdrant",
					status: "off",
					detail: "Set QDRANT_URL to enable semantic search and document ingestion",
				});
			} else {
				try {
					const info = await vectors.describe();
					checks.push({
						name: "Qdrant",
						status: "ok",
						detail: info
							? `collection "${vectors.collectionName}" — ${info.points} points, ${info.dimension} dims`
							: `connected; collection "${vectors.collectionName}" will be created on first ingest`,
					});
				} catch (err) {
					checks.push({ name: "Qdrant", status: "error", detail: errorMessage(err) });
				}
			}

			const channels = notifier.channels;
			checks.push({
				name: "Alert delivery",
				status: channels.length ? "ok" : "warn",
				detail: channels.length ? channels.join(", ") : "No channel configured — alerts only show in CLI/dashboard",
			});
			checks.push({
				name: "API server",
				status: config.server.apiKey ? "ok" : config.server.host === "127.0.0.1" ? "ok" : "warn",
				detail: `${config.server.host}:${config.server.port}${config.server.apiKey ? " · API key required" : config.server.host === "127.0.0.1" ? " · local only" : " · exposed without API_KEY"}`,
			});
			return checks;
		},

		close() {
			db.close();
		},
	};
}
