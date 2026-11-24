/** Converters for values read from result rows (SQLite and Postgres hand back slightly different JS types). */
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const flag = (v: unknown): boolean => Number(v) === 1 || v === true;
