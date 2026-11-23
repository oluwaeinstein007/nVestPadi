/**
 * Background jobs for `nvest serve`:
 * - periodic sync + alert check (never overlapping; failures logged, not fatal)
 * - history backfill for symbols with too little data, after each sync
 * - daily digests (checked every minute, idempotent per day)
 * - Telegram bot delivery: webhook when APP_URL is https and a secret is set,
 *   otherwise long polling
 */
import type { App } from "./app.js";
import { handleTelegramUpdate, telegramCommands } from "./integrations/handlers.js";
import { errorMessage, logger } from "./lib/logger.js";
import { EXCHANGES, type Exchange } from "./markets/types.js";

/** How many thin-history symbols to backfill per market after each sync. */
const BACKFILL_LIMITS: Record<Exchange, number> = { NGX: 40, US: 15, CRYPTO: 5 };
/** Data younger than this is fresh enough for a digest without re-syncing. */
const FRESH_MS = 20 * 60_000;

export class Scheduler {
	private timers: NodeJS.Timeout[] = [];
	private readonly abort = new AbortController();
	private syncing: Promise<unknown> | null = null;
	private readonly lastSync = new Map<Exchange, number>();

	constructor(private readonly app: App) {}

	/** Sync `exchanges` now and every `everyMinutes`. */
	startSync(
		everyMinutes: number,
		exchanges: Exchange[] = [...EXCHANGES],
		options: { symbols?: string[]; index?: boolean } = {},
	) {
		if (everyMinutes < 1) throw new Error("Sync interval must be at least 1 minute");
		const tick = () => void this.sync(exchanges, options);
		logger.info(`scheduler: syncing ${exchanges.join(" + ")} every ${everyMinutes} min`);
		tick();
		this.timers.push(setInterval(tick, everyMinutes * 60_000));
	}

	async sync(exchanges: Exchange[], options: { symbols?: string[]; index?: boolean } = {}) {
		if (this.syncing) {
			logger.warn("previous sync still running; skipping this tick");
			return;
		}
		const started = Date.now();
		this.syncing = this.app.syncAndAlert(exchanges, options);
		try {
			const { results, errors, triggered } = (await this.syncing) as Awaited<ReturnType<App["syncAndAlert"]>>;
			for (const r of results) this.lastSync.set(r.exchange, Date.now());
			logger.info("scheduled sync complete", {
				durationMs: Date.now() - started,
				synced: results.map((r) => `${r.exchange}:${r.bars}`).join(","),
				errors: errors.length,
				alerts: triggered.length,
			});
			void this.backfill(results.map((r) => r.exchange));
		} catch (err) {
			logger.error("scheduled sync failed", { error: errorMessage(err) });
		} finally {
			this.syncing = null;
		}
	}

	private async backfill(exchanges: Exchange[]) {
		for (const exchange of exchanges) {
			await this.app.market
				.backfill(exchange, { limit: BACKFILL_LIMITS[exchange] })
				.catch((err) => logger.warn(`${exchange} backfill failed`, { error: errorMessage(err) }));
		}
	}

	/** Check for due digests every minute. */
	startDigests() {
		const tick = async () => {
			await this.app.digests
				.runDue(new Date(), async (exchange) => {
					if (Date.now() - (this.lastSync.get(exchange) ?? 0) > FRESH_MS) await this.sync([exchange]);
				})
				.catch((err) => logger.error("digest run failed", { error: errorMessage(err) }));
		};
		this.timers.push(setInterval(() => void tick(), 60_000));
		logger.info("scheduler: daily digests enabled");
	}

	/** Connect the Telegram bot (webhook or polling). */
	async startTelegram() {
		const { telegram, config } = this.app;
		if (!telegram || !config.telegram) return;
		try {
			await telegram.setCommands(telegramCommands());
			const secret = config.telegram.webhookSecret;
			if (secret && config.auth.secureCookies) {
				await telegram.setWebhook(`${config.appUrl}/api/integrations/telegram`, secret);
				logger.info(`telegram: webhook set for @${await telegram.botUsername()}`);
				return;
			}
			await telegram.deleteWebhook();
			logger.info(`telegram: polling as @${await telegram.botUsername()}`);
			void telegram.poll((update) => handleTelegramUpdate(this.app, update), this.abort.signal);
		} catch (err) {
			logger.error("telegram bot failed to start", { error: errorMessage(err) });
		}
	}

	stop() {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.abort.abort();
	}
}
