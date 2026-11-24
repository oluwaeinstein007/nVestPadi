/** Research commands: ingest documents, semantic search and grounded AI answers. */
import { parseExchange } from "../../markets/types.js";
import { type Command, UsageError, exchangeFlag, num, out, str } from "../command.js";
import { c, table } from "../format.js";

export const researchCommands: Record<string, Command> = {
	ingest: {
		usage: "ingest url <URL> [--depth 2] [--max-pages 50] | ingest file <PATH...> | ingest list",
		summary: "Add research (web pages, PDFs, CSV, Markdown…) to the AI knowledge base",
		options: { depth: { type: "string" }, "max-pages": { type: "string" } },
		async run(app, args, flags, json) {
			const [kind, ...targets] = args;
			if (kind === "list") {
				const sources = await app.db.ledger.listSources();
				if (json) return sources;
				return out(
					table(sources, [
						{ header: "Kind", value: (s) => c.dim(s.kind) },
						{ header: "Title", value: (s) => (s.title ?? "").slice(0, 50) },
						{ header: "Chunks", value: (s) => String(s.chunks), align: "right" },
						{ header: "Indexed", value: (s) => c.dim(s.indexedAt) },
					]),
				);
			}
			if ((kind !== "url" && kind !== "file") || targets.length === 0)
				throw new UsageError("Usage: nvest ingest url <URL> | ingest file <PATH...>");
			const results = [];
			for (const target of targets) {
				const r =
					kind === "url"
						? await app.kb.ingestUrl(target, {
								maxDepth: num(flags.depth, "depth"),
								maxPages: num(flags["max-pages"], "max-pages"),
							})
						: await app.kb.ingestFile(target);
				results.push({ target, ...r });
				if (!json) {
					const what = "pages" in r ? `${r.pages} pages, ${r.chunks} chunks` : `${r.chunks} chunks`;
					out(`${c.green("✔")} ${target}  ${what} ${c.dim(`· ${r.indexed} embedded, ${r.unchanged} unchanged`)}`);
				}
			}
			return json ? results : undefined;
		},
	},
	search: {
		usage: "search <query...> [--exchange NGX|US|CRYPTO] [--limit 8]",
		summary: "Semantic search across ingested documents and market history",
		options: { ...exchangeFlag, limit: { type: "string", short: "n" } },
		async run(app, args, flags, json) {
			const query = args.join(" ").trim();
			if (!query) throw new UsageError("Missing query");
			const exchange = parseExchange(str(flags.exchange));
			const hits = await app.kb.search(query, {
				limit: num(flags.limit, "limit") ?? 8,
				filter: exchange ? { exchange } : undefined,
			});
			if (json) return hits;
			if (hits.length === 0)
				return out(c.dim("No relevant results. Ingest documents with `nvest ingest` or run `nvest sync`."));
			for (const h of hits) {
				out(`${c.bold(h.payload.title)} ${c.dim(`· ${h.payload.kind} · ${(h.score * 100).toFixed(0)}% match`)}`);
				out(`  ${c.cyan(h.payload.source)}`);
				out(`  ${h.payload.content.replace(/\s+/g, " ").slice(0, 220)}…\n`);
			}
		},
	},
	ask: {
		usage: 'ask "<question>" [--exchange NGX|US|CRYPTO]',
		summary: "Ask a question; get an answer grounded in your data, with citations",
		options: exchangeFlag,
		async run(app, args, flags, json) {
			const question = args.join(" ").trim();
			if (!question) throw new UsageError('Missing question, e.g. nvest ask "How did banking stocks do today?"');
			const a = await app.insights.ask(question, { exchange: parseExchange(str(flags.exchange)) });
			if (json) return a;
			out(`\n${a.answer.replace(/\[(\d+)\]/g, (m) => c.cyan(m))}\n`);
			if (a.sources.length) {
				out(c.dim("Sources"));
				for (const s of a.sources) out(c.dim(`  [${s.n}] ${s.title} — ${s.source}`));
			}
			out(c.dim(`\n${a.model} · information only, not investment advice`));
		},
	},
};
