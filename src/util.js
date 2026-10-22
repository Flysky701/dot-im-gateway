import {createHash, timingSafeEqual} from 'node:crypto';
export class Fault extends Error {
  constructor(code, kind = 'rejected') { super(code); this.code = code; this.kind = kind; }
}
export function ensure(condition, code = 'invalid_input') { if (!condition) throw new Fault(code); }
export function str(value, max = 256) { ensure(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008]/.test(value)); return value; }
export function exact(obj, keys) { ensure(obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k))); }
export function canonical(x) { return JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v); }
export const hash = x => createHash('sha256').update(x).digest('hex');
export const iso = ms => new Date(ms).toISOString();
export function same(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Node 24 JSON source context preserves uint64 identifiers without rewriting strings.
export function parseJson(raw) { return JSON.parse(raw.toString(), (key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^\d+$/.test(context.source) ? context.source : value); }
