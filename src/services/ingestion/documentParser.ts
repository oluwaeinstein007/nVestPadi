import fs from 'fs/promises';
import path from 'path';

export interface ParsedDocument {
  content: string;
  metadata: {
    source: string;
    type: string;
    fileName: string;
    fileSize: number;
    lastModified: string;
    [key: string]: unknown;
  };
}

/**
 * Parses local files (text, markdown, JSON, CSV) into a normalized document format.
 */
export class DocumentParser {
  async parse(filePath: string): Promise<ParsedDocument | null> {
    try {
      const stat = await fs.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const fileName = path.basename(filePath);

      const baseMetadata = {
        source: filePath,
        fileName,
        fileSize: stat.size,
        lastModified: stat.mtime.toISOString(),
        type: this.typeFromExt(ext),
      };

      const raw = await fs.readFile(filePath, 'utf8');

      if (ext === '.json') {
        return { content: this.flattenJson(raw), metadata: baseMetadata };
      }

      if (ext === '.csv') {
        return { content: this.parseCsv(raw), metadata: baseMetadata };
      }

      // txt, md, ts, js, etc. — return as-is
      return { content: raw, metadata: baseMetadata };
    } catch (err: any) {
      console.error(`DocumentParser: failed to parse ${filePath}: ${err.message}`);
      return null;
    }
  }

  private typeFromExt(ext: string): string {
    const map: Record<string, string> = {
      '.txt': 'text',
      '.md': 'markdown',
      '.json': 'json',
      '.csv': 'csv',
      '.ts': 'typescript',
      '.js': 'javascript',
    };
    return map[ext] ?? 'unknown';
  }

  private flattenJson(raw: string): string {
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj, null, 2);
    } catch {
      return raw;
    }
  }

  private parseCsv(raw: string): string {
    // Convert CSV to readable key:value lines for better embedding
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 2) return raw;
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    return lines
      .slice(1)
      .map(line => {
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        return headers.map((h, i) => `${h}: ${values[i] ?? ''}`).join(', ');
      })
      .join('\n');
  }
}
