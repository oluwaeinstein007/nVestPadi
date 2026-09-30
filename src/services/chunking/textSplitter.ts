/**
 * Simple recursive character text splitter.
 * Splits text into overlapping chunks without external WASM dependencies.
 */
export interface TextSplitterOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
}

export class TextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];

  constructor(options: TextSplitterOptions = {}) {
    this.chunkSize = options.chunkSize ?? 1000;
    this.chunkOverlap = options.chunkOverlap ?? 200;
    this.separators = options.separators ?? ['\n\n', '\n', '. ', ' ', ''];
  }

  async splitText(text: string): Promise<string[]> {
    return this.recursiveSplit(text.trim(), this.separators);
  }

  private recursiveSplit(text: string, separators: string[]): string[] {
    if (text.length <= this.chunkSize) return text ? [text] : [];

    const [sep, ...remaining] = separators;

    if (sep === undefined) {
      // Fallback: hard split by chunkSize
      return this.hardSplit(text);
    }

    const parts = sep ? text.split(sep) : text.split('');
    const chunks: string[] = [];
    let current = '';

    for (const part of parts) {
      const candidate = current ? current + sep + part : part;
      if (candidate.length <= this.chunkSize) {
        current = candidate;
      } else {
        if (current) chunks.push(current.trim());
        // Part itself is too large — recurse with next separator
        if (part.length > this.chunkSize) {
          chunks.push(...this.recursiveSplit(part, remaining));
          current = '';
        } else {
          current = part;
        }
      }
    }

    if (current.trim()) chunks.push(current.trim());

    return this.applyOverlap(chunks);
  }

  private hardSplit(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start += this.chunkSize - this.chunkOverlap;
    }
    return chunks;
  }

  private applyOverlap(chunks: string[]): string[] {
    if (this.chunkOverlap === 0 || chunks.length <= 1) return chunks;

    const result: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const overlap = prev.slice(-this.chunkOverlap);
      result.push((overlap + ' ' + chunks[i]).trim());
    }
    return result;
  }

  /** No-op: kept for API compatibility. */
  free(): void {}
}
