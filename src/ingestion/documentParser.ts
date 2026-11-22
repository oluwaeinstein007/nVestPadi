/**
 * Local file → plain text. Supports PDF (annual reports, financial statements),
 * HTML, CSV, JSON, Markdown and plain text.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseHtml } from "./webCrawler.js";

export interface ParsedDocument {
	path: string;
	title: string;
	format: string;
	content: string;
	bytes: number;
	modifiedAt: string;
}

export const SUPPORTED_EXTENSIONS = [".pdf", ".html", ".htm", ".csv", ".json", ".md", ".txt"];

export async function parseDocument(filePath: string): Promise<ParsedDocument> {
	const absolute = path.resolve(filePath);
	const ext = path.extname(absolute).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.includes(ext)) {
		throw new Error(`Unsupported file type "${ext || "(none)"}" — supported: ${SUPPORTED_EXTENSIONS.join(", ")}`);
	}
	const info = await stat(absolute);
	const buffer = await readFile(absolute);
	let title = path.basename(absolute);
	let content: string;

	switch (ext) {
		case ".pdf": {
			const { extractText, getDocumentProxy } = await import("unpdf");
			const pdf = await getDocumentProxy(new Uint8Array(buffer));
			const { text } = await extractText(pdf, { mergePages: false });
			content = (text as string[]).join("\n\n");
			break;
		}
		case ".html":
		case ".htm": {
			const page = parseHtml(`file://${absolute}`, buffer.toString("utf8"));
			title = page.title.startsWith("file://") ? title : page.title;
			content = page.content;
			break;
		}
		case ".csv":
			content = csvToText(buffer.toString("utf8"));
			break;
		case ".json":
			content = jsonToText(buffer.toString("utf8"));
			break;
		default:
			content = buffer.toString("utf8");
	}

	return {
		path: absolute,
		title,
		format: ext.slice(1),
		content: content.trim(),
		bytes: info.size,
		modifiedAt: info.mtime.toISOString(),
	};
}

function jsonToText(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

/** RFC 4180-ish CSV parser (quoted fields, escaped quotes, embedded commas/newlines). */
export function parseCsv(raw: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (quoted) {
			if (c === '"' && raw[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && raw[i + 1] === "\n") i++;
			row.push(field);
			if (row.some((f) => f.trim())) rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	row.push(field);
	if (row.some((f) => f.trim())) rows.push(row);
	return rows;
}

/** Rows become "header: value" lines — embeds far better than raw CSV. */
function csvToText(raw: string): string {
	const [header, ...rows] = parseCsv(raw);
	if (!header || rows.length === 0) return raw;
	return rows
		.map((r) =>
			header
				.map((h, i) => `${h.trim()}: ${(r[i] ?? "").trim()}`)
				.filter((pair) => !pair.endsWith(": "))
				.join(", "),
		)
		.join("\n");
}
