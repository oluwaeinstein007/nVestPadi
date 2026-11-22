/**
 * Polite same-origin web crawler (breadth-first, rate-limited, robots.txt aware).
 * Extracts readable text from HTML pages, preferring <main>/<article> content.
 */
import * as cheerio from "cheerio";
import { request } from "../lib/http.js";
import { logger } from "../lib/logger.js";

export interface CrawlOptions {
	maxDepth?: number;
	maxPages?: number;
	delayMs?: number;
}

export interface CrawledPage {
	url: string;
	title: string;
	content: string;
	depth: number;
}

const USER_AGENT = "nVestPadiBot/2.0";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function crawl(startUrl: string, options: CrawlOptions = {}): Promise<CrawledPage[]> {
	const { maxDepth = 2, maxPages = 50, delayMs = 500 } = options;
	const start = normalizeUrl(startUrl);
	const origin = new URL(start).origin;
	const disallowed = await fetchDisallowRules(origin);
	const allowed = (url: string) => !disallowed.some((rule) => new URL(url).pathname.startsWith(rule));

	const pages: CrawledPage[] = [];
	const seen = new Set<string>([start]);
	const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];

	while (queue.length > 0 && pages.length < maxPages) {
		const { url, depth } = queue.shift() as { url: string; depth: number };
		if (!allowed(url)) {
			logger.debug("skipping (robots.txt)", { url });
			continue;
		}
		try {
			const response = await request(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
				timeoutMs: 15_000,
				retries: 1,
			});
			if (!(response.headers.get("content-type") ?? "").includes("html")) continue;
			const page = parseHtml(url, await response.text());
			if (page.content) pages.push({ ...page, depth });
			logger.debug("crawled", { url, chars: page.content.length });

			if (depth < maxDepth) {
				for (const link of page.links) {
					if (!seen.has(link) && new URL(link).origin === origin) {
						seen.add(link);
						queue.push({ url: link, depth: depth + 1 });
					}
				}
			}
		} catch (err) {
			logger.warn("failed to fetch page", { url, error: err instanceof Error ? err.message : String(err) });
		}
		if (delayMs > 0 && queue.length > 0) await sleep(delayMs);
	}
	return pages;
}

export function parseHtml(url: string, html: string): { url: string; title: string; content: string; links: string[] } {
	const $ = cheerio.load(html);
	const links: string[] = [];
	$("a[href]").each((_, el) => {
		try {
			const href = new URL($(el).attr("href") as string, url);
			if (href.protocol.startsWith("http") && !/\.(pdf|jpe?g|png|gif|svg|zip|mp4|css|js)$/i.test(href.pathname)) {
				links.push(normalizeUrl(href.toString()));
			}
		} catch {
			// ignore malformed hrefs
		}
	});

	$("script, style, noscript, nav, footer, header, aside, form, iframe, svg").remove();
	const title = $("title").first().text().trim() || $("h1").first().text().trim() || url;
	const root = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
	// Keep block boundaries as newlines so the splitter can cut on paragraphs.
	root.find("p, div, li, h1, h2, h3, h4, h5, h6, tr, br, section").each((_, el) => {
		$(el).append("\n");
	});
	const content = root
		.text()
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
	return { url, title, content, links: [...new Set(links)] };
}

export function normalizeUrl(input: string): string {
	let value = input.trim().replace(/^["'﻿​]+|["'﻿​]+$/g, "");
	if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
	const url = new URL(value);
	url.hash = "";
	return url.toString();
}

async function fetchDisallowRules(origin: string): Promise<string[]> {
	try {
		const res = await request(`${origin}/robots.txt`, { timeoutMs: 5_000, retries: 0 });
		const rules: string[] = [];
		let applies = false;
		for (const raw of (await res.text()).split("\n")) {
			const line = raw.split("#")[0]?.trim() ?? "";
			const [key, ...rest] = line.split(":");
			const value = rest.join(":").trim();
			if (/^user-agent$/i.test(key ?? "")) applies = value === "*" || value.toLowerCase().includes("nvestpadi");
			else if (applies && /^disallow$/i.test(key ?? "") && value) rules.push(value);
		}
		return rules;
	} catch {
		return [];
	}
}
