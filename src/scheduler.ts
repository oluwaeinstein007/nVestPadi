/**
 * Periodic sync + alert check. Runs immediately, then every N minutes; a run
 * never overlaps the previous one, and failures are logged, not fatal.
 */
import type { App } from "./app.js";
import { errorMessage, logger } from "./lib/logger.js";
import type { Exchange } from "./markets/types.js";

export function startScheduler(
	app: App,
	everyMinutes: number,
	exchanges: Exchange[],
	options: { symbols?: string[]; index?: boolean },
): () => void {
	if (everyMinutes < 1) throw new Error("Sync interval must be at least 1 minute");
	let running = false;

	const tick = async () => {
		if (running) {
			logger.warn("previous sync still running; skipping this tick");
			return;
		}
		running = true;
		const started = Date.now();
		try {
			const { results, errors, triggered } = await app.syncAndAlert(exchanges, options);
			logger.info("scheduled sync complete", {
				durationMs: Date.now() - started,
				synced: results.map((r) => `${r.exchange}:${r.bars}`).join(","),
				errors: errors.length,
				alerts: triggered.length,
			});
		} catch (err) {
			logger.error("scheduled sync failed", { error: errorMessage(err) });
		} finally {
			running = false;
		}
	};

	logger.info(`scheduler started — syncing ${exchanges.join(" + ")} every ${everyMinutes} min`);
	void tick();
	const timer = setInterval(tick, everyMinutes * 60_000);
	return () => clearInterval(timer);
}
