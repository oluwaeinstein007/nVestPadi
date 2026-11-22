/**
 * Recursive character text splitter.
 *
 * 1. Recursively break text on the coarsest separator that works
 *    (paragraph → line → sentence → word → hard cut) into pieces ≤ the budget.
 * 2. Greedily pack pieces into chunks, prefixing each chunk after the first
 *    with the tail of the previous one for context continuity.
 *
 * Every chunk is guaranteed to be at most `chunkSize` characters.
 */
export interface TextSplitterOptions {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
}

export class TextSplitter {
	private readonly chunkSize: number;
	private readonly chunkOverlap: number;
	private readonly separators: string[];

	constructor(options: TextSplitterOptions = {}) {
		this.chunkSize = options.chunkSize ?? 1000;
		this.chunkOverlap = options.chunkOverlap ?? 200;
		this.separators = options.separators ?? ["\n\n", "\n", ". ", " "];
		if (this.chunkOverlap >= this.chunkSize) {
			throw new Error("chunkOverlap must be smaller than chunkSize");
		}
	}

	split(text: string): string[] {
		const normalized = text.replace(/\r\n/g, "\n").trim();
		if (!normalized) return [];
		if (normalized.length <= this.chunkSize) return [normalized];

		const budget = this.chunkSize - this.chunkOverlap;
		const pieces = this.atomize(normalized, this.separators, budget);

		const chunks: string[] = [];
		let current = "";
		for (const piece of pieces) {
			const candidate = current ? `${current} ${piece}` : piece;
			if (candidate.length <= budget) {
				current = candidate;
			} else {
				if (current) chunks.push(current);
				current = piece;
			}
		}
		if (current) chunks.push(current);

		return chunks.map((c, i) => {
			if (i === 0 || this.chunkOverlap === 0) return c;
			const tail = (chunks[i - 1] as string).slice(-this.chunkOverlap);
			// Start the overlap on a word boundary where possible.
			const space = tail.indexOf(" ");
			const overlap = space > 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
			return `${overlap} ${c}`.slice(0, this.chunkSize);
		});
	}

	private atomize(text: string, separators: string[], budget: number): string[] {
		const trimmed = text.trim();
		if (!trimmed) return [];
		if (trimmed.length <= budget) return [trimmed];

		const [sep, ...rest] = separators;
		if (sep === undefined) {
			const out: string[] = [];
			for (let i = 0; i < trimmed.length; i += budget) out.push(trimmed.slice(i, i + budget));
			return out;
		}
		return trimmed
			.split(sep)
			.flatMap((part, i, all) => this.atomize(sep === ". " && i < all.length - 1 ? `${part}.` : part, rest, budget));
	}
}
