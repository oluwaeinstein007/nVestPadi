import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AIProvider, ChatMessage } from "../src/ai/provider.js";
import { InsightService } from "../src/services/insightService.js";
import { KnowledgeBase } from "../src/services/knowledgeBase.js";
import { MarketService } from "../src/services/marketService.js";
import type { SearchHit, VectorPoint, VectorStore } from "../src/storage/vectorStore.js";
import { memoryDb, security, seed } from "./helpers.js";
import { marketOptions } from "./helpers.js";

class StubAI implements AIProvider {
	readonly name = "stub";
	readonly chatModel = "stub-chat";
	readonly embeddingModel = "stub-embed";
	embedCalls: string[][] = [];
	lastPrompt: ChatMessage[] = [];
	async embed(texts: string[]) {
		this.embedCalls.push(texts);
		return texts.map((t) => [t.length, 1, 0]);
	}
	async chat(messages: ChatMessage[]) {
		this.lastPrompt = messages;
		return "GTCO closed higher [1].";
	}
}

class StubVectors {
	points = new Map<string, VectorPoint>();
	hits: SearchHit[] = [];
	async upsert(points: VectorPoint[]) {
		for (const p of points) this.points.set(p.id, p);
	}
	async search(): Promise<SearchHit[]> {
		return this.hits;
	}
}

const closes = Array.from({ length: 70 }, (_, i) => 100 + i);

function setup() {
	const db = memoryDb();
	seed(db, [{ s: security("GTCO", "Guaranty Trust Holding Company Plc", "Financial Services"), closes }]);
	const ai = new StubAI();
	const vectors = new StubVectors();
	const kb = new KnowledgeBase(db, ai, vectors as unknown as VectorStore);
	const insights = new InsightService(db, ai, kb, new MarketService(db, kb, marketOptions));
	return { db, ai, vectors, kb, insights };
}

describe("knowledge base indexing", () => {
	it("embeds only new or changed chunks", async () => {
		const { ai, vectors, kb } = setup();
		const item = (id: string, text: string) => ({
			id,
			text,
			payload: { kind: "file" as const, source: "a.md", title: "A" },
		});

		assert.deepEqual(await kb.index([item("1", "alpha"), item("2", "beta")]), { indexed: 2, unchanged: 0 });
		assert.deepEqual(await kb.index([item("1", "alpha"), item("2", "beta")]), { indexed: 0, unchanged: 2 });
		assert.deepEqual(await kb.index([item("1", "alpha"), item("2", "beta v2")]), { indexed: 1, unchanged: 1 });

		assert.equal(ai.embedCalls.length, 2);
		assert.equal(vectors.points.get("2")?.payload.content, "beta v2");
	});

	it("drops legacy points that carry no text", async () => {
		const { vectors, kb } = setup();
		vectors.hits = [
			{ id: "old", score: 0.9, payload: { stock_symbol: "X" } as never },
			{ id: "new", score: 0.8, payload: { kind: "web", source: "s", title: "t", content: "text", indexedAt: "" } },
		];
		assert.deepEqual(
			(await kb.search("q")).map((h) => h.id),
			["new"],
		);
	});
});

describe("ask", () => {
	it("grounds the answer in the symbol report and retrieved documents, with numbered sources", async () => {
		const { ai, vectors, insights } = setup();
		vectors.hits = [
			{
				id: "d1",
				score: 0.82,
				payload: {
					kind: "file",
					source: "/reports/gtco-q3.pdf",
					title: "GTCO Q3 results",
					content: "PBT up 40%",
					indexedAt: "",
				},
			},
		];
		const answer = await insights.ask("How is GTCO doing?");

		assert.equal(answer.answer, "GTCO closed higher [1].");
		assert.deepEqual(answer.symbols, ["NGX:GTCO"]);
		assert.deepEqual(
			answer.sources.map((s) => s.kind),
			["analysis", "file"],
		);
		const prompt = ai.lastPrompt.map((m) => m.content).join("\n");
		assert.match(prompt, /\[1\] Guaranty Trust Holding Company Plc technical snapshot/);
		assert.match(prompt, /\[2\] GTCO Q3 results/);
		assert.match(prompt, /Answer ONLY from the numbered context/);
	});

	it("explains what to do when there is no data at all", async () => {
		const db = memoryDb();
		const ai = new StubAI();
		const kb = new KnowledgeBase(db, ai, null);
		const answer = await new InsightService(db, ai, kb, new MarketService(db, kb, marketOptions)).ask(
			"What happened today?",
		);
		assert.match(answer.answer, /nvest sync/);
		assert.equal(ai.lastPrompt.length, 0);
	});
});
