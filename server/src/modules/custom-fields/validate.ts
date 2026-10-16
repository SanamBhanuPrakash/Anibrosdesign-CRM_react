/**
 * Custom lead fields: the rules that turn what a person typed into what is stored.
 *
 * Each client defines its own fields (see docs/AGENCY_DESIGN.md). The definitions are the schema; the values live on the lead as JSON.
 * Everything here is pure (no database), so every rule can be tested on its own.
 *
 * Stored shapes: text/select/url/email → string, number → number, boolean → true/false, date → "YYYY-MM-DD",
 * multi_select → string[] of option VALUES. An empty value is "not set": the key is simply absent.
 */
export const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multi_select', 'url', 'email'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Visible fields take part in forms and validation. Hidden (retired) fields keep their saved values but accept no new ones. */
  visible: boolean;
  options: FieldOption[];
  defaultValue: string | null;
  helpText: string | null;
  showInList: boolean;
  order: number;
}

export interface Problem {
  path: string;
  message: string;
}

export const MAX_FIELDS_PER_CLIENT = 50;
export const MAX_OPTIONS = 50;
export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

const slug = (s: string, max: number) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');

/** "Treatment interested in" → treatment_interested_in; unique among `taken`; always a valid key. */
export function fieldKeyFromLabel(label: string, taken: ReadonlySet<string>): string {
  let base = slug(label, 36);
  if (!base) base = 'field';
  if (!/^[a-z]/.test(base)) base = `f_${base}`.slice(0, 36);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base.slice(0, 36 - String(n).length - 1)}_${n}`;
  return key;
}

/** Options may be given as plain labels or as {value,label}. Values are stable identifiers; labels can be renamed later. */
export function normalizeOptions(input: Array<string | { value?: string; label: string }>): { options: FieldOption[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const options: FieldOption[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of input.entries()) {
    const label = (typeof raw === 'string' ? raw : raw.label).trim();
    if (!label) {
      problems.push({ path: `body.options.${i}`, message: 'An option needs a name' });
      continue;
    }
    if (label.length > 80) problems.push({ path: `body.options.${i}`, message: 'Option names are at most 80 characters' });
    const given = typeof raw === 'string' ? undefined : raw.value?.trim();
    let value = given || slug(label, 40) || `option_${i + 1}`;
    if (given && !/^[a-z0-9][a-z0-9_]{0,39}$/.test(given)) problems.push({ path: `body.options.${i}.value`, message: 'Use lowercase letters, digits and underscores' });
    for (let n = 2; seen.has(value) && !given; n++) value = `${slug(label, 36)}_${n}`;
    if (seen.has(value)) problems.push({ path: `body.options.${i}`, message: `Two options share the value “${value}”` });
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) problems.push({ path: `body.options.${i}`, message: `“${label}” is listed twice` });
    seen.add(value);
    options.push({ value, label });
  }
  if (options.length > MAX_OPTIONS) problems.push({ path: 'body.options', message: `At most ${MAX_OPTIONS} options` });
  return { options, problems };
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

const YES = new Set(['true', 'yes', 'y', '1']);
const NO = new Set(['false', 'no', 'n', '0']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Normalise one value for one field. `null` result = blank (clear it). */
export function normalizeValue(def: Pick<FieldDef, 'type' | 'options' | 'label'>, raw: unknown): { ok: true; value: string | number | boolean | string[] | null } | { ok: false; message: string } {
  if (isBlank(raw)) return { ok: true, value: null };
  const fail = (message: string) => ({ ok: false as const, message });
  // Only a multi-select takes a list. Anything list- or object-shaped sent to another type would otherwise be silently turned into text.
  if (typeof raw === 'object' && def.type !== 'multi_select') return fail('Enter a single value');
  switch (def.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail('Enter text');
      const s = String(raw).trim();
      return s.length > 500 ? fail('At most 500 characters') : { ok: true, value: s };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.replace(/,/g, '').trim()) : Number.NaN;
      if (!Number.isFinite(n)) return fail('Enter a number');
      return Math.abs(n) > 1e13 ? fail('That number is too large') : { ok: true, value: n };
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim().slice(0, 10) : '';
      return validDate(s) ? { ok: true, value: s } : fail('Use a date like 2026-10-31');
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      return YES.has(s) ? { ok: true, value: true } : NO.has(s) ? { ok: true, value: false } : fail('Choose yes or no');
    }
    case 'select': {
      const s = String(raw).trim();
      const o = def.options.find((x) => x.value === s) ?? def.options.find((x) => x.label.toLowerCase() === s.toLowerCase());
      return o ? { ok: true, value: o.value } : fail(`Choose one of: ${def.options.map((x) => x.label).join(', ')}`);
    }
    case 'multi_select': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : null;
      if (!list) return fail('Choose one or more options');
      const out: string[] = [];
      for (const item of list) {
        const s = String(item).trim();
        if (!s) continue;
        const o = def.options.find((x) => x.value === s) ?? def.options.find((x) => x.label.toLowerCase() === s.toLowerCase());
        if (!o) return fail(`“${s}” is not one of: ${def.options.map((x) => x.label).join(', ')}`);
        if (!out.includes(o.value)) out.push(o.value);
      }
      return out.length ? { ok: true, value: out } : { ok: true, value: null };
    }
    case 'url': {
      const s = String(raw).trim();
      try {
        const u = new URL(s);
        if (!['http:', 'https:'].includes(u.protocol) || s.length > 500) return fail('Enter a web address starting with http:// or https://');
        return { ok: true, value: s };
      } catch {
        return fail('Enter a web address starting with http:// or https://');
      }
    }
    case 'email': {
      const s = String(raw).trim().toLowerCase();
      return EMAIL_RE.test(s) && s.length <= 254 ? { ok: true, value: s } : fail('Enter an e-mail address');
    }
  }
}

export interface ValidateOptions {
  mode: 'create' | 'patch';
  /** Required fields are demanded of people (and API keys) saving a lead, not of automatic intake (ad forms, imports). */
  enforceRequired: boolean;
}

export interface ValidatedFields {
  /** Normalised values to store (merged over what is already there). */
  set: Record<string, unknown>;
  /** Keys to remove (a person blanked them). */
  clear: string[];
  problems: Problem[];
}

/**
 * Check `input` against the client's definitions.
 *  create: unknown or hidden keys are errors; defaults fill in fields nobody answered; required fields must be present.
 *  patch:  only the keys sent are touched (everything else on the lead is left alone); blanking a required field is an error.
 */
export function validateCustomFields(defs: FieldDef[], input: Record<string, unknown> | undefined, opts: ValidateOptions): ValidatedFields {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  const problems: Problem[] = [];

  for (const [key, raw] of Object.entries(input ?? {})) {
    const path = `body.customFields.${key}`;
    const def = byKey.get(key);
    if (!def) {
      problems.push({ path, message: `“${key}” is not a field of this client. Add it under Custom fields first` });
      continue;
    }
    if (!def.visible) {
      problems.push({ path, message: `“${def.label}” is hidden and can no longer be changed` });
      continue;
    }
    const r = normalizeValue(def, raw);
    if (!r.ok) {
      problems.push({ path, message: `${def.label}: ${r.message}` });
      continue;
    }
    if (r.value === null) {
      if (opts.mode === 'patch') {
        if (def.required && opts.enforceRequired) problems.push({ path, message: `${def.label} is required` });
        else clear.push(key);
      }
    } else set[key] = r.value;
  }

  if (opts.mode === 'create') {
    for (const def of defs) {
      if (!def.visible || key_in(set, def.key)) continue;
      if (def.defaultValue !== null) {
        const d = normalizeValue(def, def.defaultValue);
        if (d.ok && d.value !== null) {
          set[def.key] = d.value;
          continue;
        }
      }
      if (def.required && opts.enforceRequired) problems.push({ path: `body.customFields.${def.key}`, message: `${def.label} is required` });
    }
  }
  return { set, clear, problems };
}

const key_in = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Human-readable text for a stored value (export, screens): option labels instead of codes, Yes/No instead of true/false. */
export function displayValue(def: Pick<FieldDef, 'type' | 'options'>, stored: unknown): string | number | null {
  if (stored === null || stored === undefined) return null;
  const label = (v: unknown) => def.options.find((o) => o.value === v)?.label ?? String(v);
  if (def.type === 'boolean') return stored === true ? 'Yes' : stored === false ? 'No' : String(stored);
  if (def.type === 'select') return label(stored);
  if (def.type === 'multi_select') return Array.isArray(stored) ? stored.map(label).join('; ') : String(stored);
  if (def.type === 'number') return typeof stored === 'number' ? stored : Number(stored);
  return String(stored);
}
