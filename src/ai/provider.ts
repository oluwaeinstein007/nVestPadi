/**
 * AI provider abstraction: embeddings for semantic search and chat completions
 * for grounded answers. Implemented against the providers' REST APIs directly
 * (no SDK dependencies). Failures throw — callers must never store fake vectors.
 */
import type { AIConfig } from "../config.js";
import { HttpError, postJson } from "../lib/http.js";
import { chunk } from "../lib/util.js";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** `document` for content being indexed, `query` for a search string. */
export type EmbeddingKind = "document" | "query";

export interface AIProvider {
	readonly name: string;
	readonly chatModel: string;
	readonly embeddingModel: string;
	embed(texts: string[], kind?: EmbeddingKind): Promise<number[][]>;
	chat(messages: ChatMessage[]): Promise<string>;
}

export class AIError extends Error {
	constructor(provider: string, cause: unknown) {
		let detail = cause instanceof Error ? cause.message : String(cause);
		if (cause instanceof HttpError && cause.body) {
			try {
				const parsed = JSON.parse(cause.body);
				detail = `${cause.status}: ${parsed?.error?.message ?? cause.body}`;
			} catch {
				detail = `${cause.status}: ${cause.body.slice(0, 300)}`;
			}
		}
		super(`${provider} request failed — ${detail}`);
		this.name = "AIError";
	}
}

const EMBED_BATCH = 100;

class OpenAIProvider implements AIProvider {
	readonly name = "openai";
	readonly chatModel: string;
	readonly embeddingModel: string;
	private readonly base = "https://api.openai.com/v1";

	constructor(private readonly config: AIConfig) {
		this.chatModel = config.chatModel;
		this.embeddingModel = config.embeddingModel;
	}

	private get headers() {
		return { Authorization: `Bearer ${this.config.apiKey}` };
	}

	async embed(texts: string[]): Promise<number[][]> {
		const out: number[][] = [];
		for (const batch of chunk(texts, EMBED_BATCH)) {
			try {
				const res = await postJson<{ data: { index: number; embedding: number[] }[] }>(
					`${this.base}/embeddings`,
					{
						model: this.embeddingModel,
						input: batch,
						...(this.config.embeddingDimensions && { dimensions: this.config.embeddingDimensions }),
					},
					{ headers: this.headers, timeoutMs: 60_000 },
				);
				out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
			} catch (err) {
				throw new AIError("OpenAI embeddings", err);
			}
		}
		return out;
	}

	async chat(messages: ChatMessage[]): Promise<string> {
		try {
			const res = await postJson<{ choices: { message: { content: string | null } }[] }>(
				`${this.base}/chat/completions`,
				{ model: this.chatModel, messages },
				{ headers: this.headers, timeoutMs: 120_000, retries: 1 },
			);
			return res.choices[0]?.message.content?.trim() ?? "";
		} catch (err) {
			throw new AIError("OpenAI chat", err);
		}
	}
}

class GeminiProvider implements AIProvider {
	readonly name = "gemini";
	readonly chatModel: string;
	readonly embeddingModel: string;
	private readonly base = "https://generativelanguage.googleapis.com/v1beta/models";

	constructor(private readonly config: AIConfig) {
		this.chatModel = config.chatModel;
		this.embeddingModel = config.embeddingModel;
	}

	// Header auth keeps the key out of URLs (and therefore out of logs).
	private get headers() {
		return { "x-goog-api-key": this.config.apiKey };
	}

	async embed(texts: string[], kind: EmbeddingKind = "document"): Promise<number[][]> {
		const out: number[][] = [];
		for (const batch of chunk(texts, EMBED_BATCH)) {
			try {
				const res = await postJson<{ embeddings: { values: number[] }[] }>(
					`${this.base}/${this.embeddingModel}:batchEmbedContents`,
					{
						requests: batch.map((text) => ({
							model: `models/${this.embeddingModel}`,
							content: { parts: [{ text }] },
							taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
							...(this.config.embeddingDimensions && {
								outputDimensionality: this.config.embeddingDimensions,
							}),
						})),
					},
					{ headers: this.headers, timeoutMs: 60_000 },
				);
				out.push(...res.embeddings.map((e) => e.values));
			} catch (err) {
				throw new AIError("Gemini embeddings", err);
			}
		}
		return out;
	}

	async chat(messages: ChatMessage[]): Promise<string> {
		const system = messages
			.filter((m) => m.role === "system")
			.map((m) => m.content)
			.join("\n\n");
		const contents = messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
		try {
			const res = await postJson<{
				candidates?: { content?: { parts?: { text?: string }[] } }[];
			}>(
				`${this.base}/${this.chatModel}:generateContent`,
				{ ...(system && { systemInstruction: { parts: [{ text: system }] } }), contents },
				{ headers: this.headers, timeoutMs: 120_000, retries: 1 },
			);
			return (res.candidates?.[0]?.content?.parts ?? [])
				.map((p) => p.text ?? "")
				.join("")
				.trim();
		} catch (err) {
			throw new AIError("Gemini chat", err);
		}
	}
}

export function createAIProvider(config: AIConfig | null): AIProvider | null {
	if (!config) return null;
	return config.provider === "openai" ? new OpenAIProvider(config) : new GeminiProvider(config);
}
