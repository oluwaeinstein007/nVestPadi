import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv } from "../src/ingestion/documentParser.js";
import { TextSplitter } from "../src/ingestion/textSplitter.js";
import { normalizeUrl, parseHtml } from "../src/ingestion/webCrawler.js";

describe("TextSplitter", () => {
	const text = Array.from(
		{ length: 60 },
		(_, i) => `Paragraph ${i} talks about Nigerian equities and dividends in some detail.`,
	).join("\n\n");

	it("never exceeds chunkSize", () => {
		const chunks = new TextSplitter({ chunkSize: 300, chunkOverlap: 50 }).split(text);
		assert.ok(chunks.length > 5);
		for (const c of chunks) assert.ok(c.length <= 300, `chunk of ${c.length}`);
	});

	it("overlaps consecutive chunks", () => {
		const chunks = new TextSplitter({ chunkSize: 300, chunkOverlap: 60 }).split(text);
		const tail = (chunks[0] as string).slice(-20);
		assert.ok((chunks[1] as string).includes(tail.trim().split(" ").at(-1) as string));
	});

	it("hard-splits text with no separators", () => {
		const chunks = new TextSplitter({ chunkSize: 100, chunkOverlap: 0 }).split("x".repeat(450));
		assert.equal(chunks.length, 5);
	});

	it("returns [] for blank input and rejects overlap >= size", () => {
		assert.deepEqual(new TextSplitter().split("   "), []);
		assert.throws(() => new TextSplitter({ chunkSize: 100, chunkOverlap: 100 }));
	});
});

describe("parseCsv", () => {
	it("handles quoted commas, escaped quotes and CRLF", () => {
		const rows = parseCsv('name,note\r\n"Dangote, Cement","said ""hi"""\r\nGTCO,ok\r\n');
		assert.deepEqual(rows, [
			["name", "note"],
			["Dangote, Cement", 'said "hi"'],
			["GTCO", "ok"],
		]);
	});
});

describe("web helpers", () => {
	it("normalizes URLs", () => {
		assert.equal(normalizeUrl(" example.com/a#top "), "https://example.com/a");
		assert.equal(normalizeUrl('"https://x.org/"'), "https://x.org/");
	});

	it("extracts main content and links, dropping chrome", () => {
		const page = parseHtml(
			"https://site.ng/",
			`<html><head><title>Results</title></head><body><nav>Menu</nav><main><h1>Q3</h1><p>Profit rose 20%.</p><a href="/next">next</a><a href="/r.pdf">pdf</a></main><footer>©</footer></body></html>`,
		);
		assert.equal(page.title, "Results");
		assert.match(page.content, /Profit rose 20%/);
		assert.doesNotMatch(page.content, /Menu|©/);
		assert.deepEqual(page.links, ["https://site.ng/next"]);
	});
});
