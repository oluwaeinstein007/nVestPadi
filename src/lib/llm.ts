import axios from 'axios';

// Note: '@langchain/openai' is an optional dependency in many environments. To avoid throwing
// a module-not-found error at import time, we `require` it dynamically inside the OpenAIWrapper
// constructor. This lets code that doesn't need OpenAI embeddings avoid installing the package.


export type LLMProvider = 'openai' | 'gemini';

export interface LLMOptions {
  provider?: LLMProvider;
  apiKey?: string;
}

export type Embeddings = {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

class OpenAIWrapper implements Embeddings {
  private client: any;
  constructor(apiKey: string) {
    // Dynamically require the optional package so modules that don't have
    // this dependency installed don't fail to import this file.
    let OpenAIEmbeddings: any;
    try {
      // Use require to avoid top-level ES module import errors when package is not present
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      OpenAIEmbeddings = require('@langchain/openai').OpenAIEmbeddings;
    } catch (err) {
      throw new Error('OpenAI embeddings package (@langchain/openai) is not installed. Set LLM_PROVIDER=gemini or install @langchain/openai.');
    }

    this.client = new OpenAIEmbeddings({ apiKey });
  }

  async embedDocuments(texts: string[]) {
    return await this.client.embedDocuments(texts);
  }

  async embedQuery(text: string) {
    const r = await this.client.embedQuery(text);
    return r;
  }
}

class GeminiWrapper implements Embeddings {
  private apiKey: string;
  // Use the recommended model for embeddings
  private model: string; 

  // Default to the recommended model for embeddings
  constructor(apiKey: string, model = 'text-embedding-004') {
    this.apiKey = apiKey;
    this.model = model;
  }

  private async requestEmbeddings(texts: string[]) {
    if (!this.apiKey) {
      throw new Error('GOOGLE_API_KEY is required for Gemini embeddings.');
    }

    // Gemini batchEmbedContents has a limit of 100 requests per call
    const CHUNK_SIZE = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
      const chunk = texts.slice(i, i + CHUNK_SIZE);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;

      try {
        const resp = await axios.post(
          url,
          {
            requests: chunk.map((text) => ({
              model: `models/${this.model}`,
              content: { parts: [{ text }] },
            })),
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );

        if (Array.isArray(resp.data?.embeddings)) {
          allEmbeddings.push(...resp.data.embeddings.map((item: any) => item.values));
        } else {
          throw new Error('Could not parse Gemini embeddings response: ' + JSON.stringify(resp.data));
        }
      } catch (error: any) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error('Gemini API Error:', error.response?.data || error.message);
        throw new Error(`Gemini embeddings failed: ${errorMsg}`);
      }
    }

    return allEmbeddings;
  }

  async embedDocuments(texts: string[]) {
    return await this.requestEmbeddings(texts);
  }

  async embedQuery(text: string) {
    const r = await this.embedDocuments([text]);
    return r[0];
  }
}

// ... The rest of your code remains the same
export function createEmbeddings(options: LLMOptions = {}): Embeddings {
  const provider = options.provider || (process.env.LLM_PROVIDER as LLMProvider) || 'openai';

  if (provider === 'openai') {
    const apiKey = options.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('OPENAI_API_KEY or LLM_API_KEY is required for OpenAI provider');
    return new OpenAIWrapper(apiKey);
  }

  if (provider === 'gemini') {
    const apiKey = options.apiKey || process.env.GOOGLE_API_KEY || process.env.LLM_API_KEY || '';
    const model = process.env.GOOGLE_EMBEDDING_MODEL || 'gemini-embedding-001';

    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY or LLM_API_KEY is required for Gemini embeddings. Get one at: https://aistudio.google.com/app/apikey');
    }

    return new GeminiWrapper(apiKey, model);
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

export default createEmbeddings;
