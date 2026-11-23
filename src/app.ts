/**
 * Composition root: builds every service from config. Shared by the CLI and
 * the HTTP server so both behave identically.
 */
import { type AIProvider, createAIProvider } from "./ai/provider.js";
import type { Config } from "./config.js";
import { TelegramClient } from "./integrations/telegram.js";
import { errorMessage, logger } from "./lib/logger.js";
import { CoinGecko } from "./markets/coingecko.js";
import type { Exchange } from "./markets/types.js";
import { AccountService } from "./services/accountService.js";
import { AlertService, type TriggeredAlert } from "./services/alertService.js";
import { AuthService } from "./services/authService.js";
import { BillingService } from "./services/billingService.js";
import { BotService } from "./services/botService.js";
import { DigestService } from "./services/digestService.js";
import { InsightService } from "./services/insightService.js";
import { KnowledgeBase } from "./services/knowledgeBase.js";
import { type Mailer, createMailer } from "./services/mailer.js";
import { MarketService, type SyncResult } from "./services/marketService.js";
import { Notifier } from "./services/notifier.js";
import { PortfolioService } from "./services/portfolioService.js";
import { WatchlistService } from "./services/watchlistService.js";
import { Database } from "./storage/database.js";
import { VectorStore } from "./storage/vectorStore.js";

export interface App {
	config: Config;
	db: Database;
	ai: AIProvider | null;
	vectors: VectorStore | null;
	mailer: Mailer;
	kb: KnowledgeBase;
	market: MarketService;
	insights: InsightService;
	notifier: Notifier;
	alerts: AlertService;
	watchlists: WatchlistService;
	auth: AuthService;
	accounts: AccountService;
	billing: BillingService;
	portfolio: PortfolioService;
	digests: DigestService;
	bots: BotService;
	/** Server-wide Telegram bot, when TELEGRAM_BOT_TOKEN is set. */
	telegram: TelegramClient | null;
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

export function createApp(config: Config, overrides: { mailer?: Mailer } = {}): App {
	const db = new Database(config.databasePath);
	const ai = createAIProvider(config.ai);
	const vectors = config.qdrant ? new VectorStore(config.qdrant) : null;
	const mailer = overrides.mailer ?? createMailer(config.email);
	const kb = new KnowledgeBase(db, ai, vectors);
	const market = new MarketService(db, kb, {
		usSymbols: config.markets.usSymbols,
		coingecko: new CoinGecko(config.coingeckoApiKey),
	});
	const telegram = config.telegram ? new TelegramClient(config.telegram.botToken) : null;
	const insights = new InsightService(db, ai, kb, market);
	const notifier = new Notifier(mailer, telegram, config.mode, config.appUrl);
	const alerts = new AlertService(db, notifier, config.mode);
	const watchlists = new WatchlistService(db, market, config.mode);
	const auth = new AuthService(db, mailer, config);
	const accounts = new AccountService(db, auth, notifier, watchlists, config.mode);
	const billing = new BillingService(db, config.billing, config.appUrl, config.mode);
	const portfolio = new PortfolioService(db, market, config.mode);
	const digests = new DigestService(db, notifier, watchlists, portfolio, {
		telegram,
		telegramChatId: config.telegram?.broadcastChatId ?? null,
		discordWebhookUrl: config.discord.broadcastWebhookUrl,
		appUrl: config.appUrl,
	});

	for (const warning of config.warnings) logger.warn(warning);

	const app: App = {
		config,
		db,
		ai,
		vectors,
		mailer,
		kb,
		market,
		insights,
		notifier,
		alerts,
		watchlists,
		auth,
		accounts,
		billing,
		portfolio,
		digests,
		telegram,
		// Assigned below: the bot needs the finished app.
		bots: undefined as unknown as BotService,

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
			db.users.purgeExpired();
			return { results, errors, triggered };
		},

		async doctor() {
			const checks: HealthCheck[] = [];
			const stats = db.stats();
			checks.push({
				name: "Mode",
				status: "ok",
				detail: `${config.mode} · ${config.appUrl}`,
			});
			checks.push({
				name: "Database",
				status: "ok",
				detail: `${config.databasePath} — schema v${db.schemaVersion}, ${stats.securities} securities, ${stats.prices} price rows${stats.lastPriceDate ? `, latest ${stats.lastPriceDate}` : ""}`,
			});

			const signup = auth.signupStatus();
			checks.push({
				name: "Accounts",
				status: stats.users === 0 ? "warn" : "ok",
				detail:
					stats.users === 0
						? `No accounts yet — sign up at ${config.appUrl}/signup (the first account becomes the owner)`
						: `${stats.users} account${stats.users === 1 ? "" : "s"} · sign-up ${signup.open ? "open" : "closed"}`,
			});

			checks.push({
				name: "Email",
				status: mailer.delivers ? "ok" : config.mode === "cloud" ? "error" : "warn",
				detail: mailer.delivers
					? `Resend · from ${config.email?.from}`
					: "Not configured — verification/reset links are written to the server log. Set RESEND_API_KEY + EMAIL_FROM",
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

			if (!telegram) {
				checks.push({
					name: "Telegram",
					status: "off",
					detail: "Set TELEGRAM_BOT_TOKEN to offer a bot, alerts and digests",
				});
			} else {
				try {
					const username = await telegram.botUsername();
					checks.push({
						name: "Telegram",
						status: "ok",
						detail: `@${username} · ${config.telegram?.webhookSecret && config.auth.secureCookies ? "webhook" : "polling"}${config.telegram?.broadcastChatId ? ` · digests → ${config.telegram.broadcastChatId}` : " · no broadcast chat (TELEGRAM_CHAT_ID)"}`,
					});
				} catch (err) {
					checks.push({ name: "Telegram", status: "error", detail: errorMessage(err) });
				}
			}
			checks.push({
				name: "Discord",
				status: config.discord.app || config.discord.broadcastWebhookUrl ? "ok" : "off",
				detail:
					[
						config.discord.broadcastWebhookUrl && "digests → channel webhook",
						config.discord.app && `slash commands at ${config.appUrl}/api/integrations/discord`,
					]
						.filter(Boolean)
						.join(" · ") ||
					"Set DISCORD_WEBHOOK_URL for digests, DISCORD_APPLICATION_ID + DISCORD_PUBLIC_KEY for slash commands",
			});
			checks.push({
				name: "Digests",
				status: config.digests ? "ok" : "off",
				detail: config.digests
					? "Daily market + personal digests (NGX 15:00, US 21:30, crypto 07:00 UTC) while `serve` runs"
					: "DAILY_DIGEST=false",
			});

			if (config.mode === "cloud") {
				checks.push({
					name: "Billing",
					status: billing.enabled ? "ok" : "warn",
					detail: billing.enabled
						? `Paystack · plan ${config.billing?.planCode} · webhook ${config.appUrl}/api/billing/webhook`
						: "Not configured — everyone stays on Free. Set PAYSTACK_SECRET_KEY + PAYSTACK_PLAN_CODE",
				});
			}

			const exposed = config.server.host !== "127.0.0.1" && config.server.host !== "localhost";
			checks.push({
				name: "API server",
				status: exposed && !config.auth.secureCookies && config.env === "production" ? "warn" : "ok",
				detail: `${config.server.host}:${config.server.port}${exposed && !config.auth.secureCookies ? " · serve it over HTTPS (APP_URL=https://…) before exposing it" : ""}`,
			});

			for (const warning of config.warnings) checks.push({ name: "Config", status: "warn", detail: warning });
			return checks;
		},

		close() {
			db.close();
		},
	};
	app.bots = new BotService(app);
	return app;
}
