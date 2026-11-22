/** Ordered cleanup on SIGINT/SIGTERM (e.g. stop accepting HTTP requests, then close the DB). */
import { logger } from "./logger.js";

const handlers: (() => void | Promise<void>)[] = [];
let installed = false;
let shuttingDown = false;

export function onShutdown(fn: () => void | Promise<void>) {
	handlers.unshift(fn); // last registered runs first
	if (installed) return;
	installed = true;
	const run = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info(`received ${signal}, shutting down`);
		const force = setTimeout(() => process.exit(1), 10_000);
		force.unref();
		for (const h of handlers) {
			try {
				await h();
			} catch (err) {
				logger.warn("shutdown handler failed", { error: String(err) });
			}
		}
		process.exit(0);
	};
	process.once("SIGINT", () => void run("SIGINT"));
	process.once("SIGTERM", () => void run("SIGTERM"));
}
