import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import {
  KEY_RE, MAX_FIELDS_PER_CLIENT, fieldKeyFromLabel, normalizeOptions, normalizeValue, type FieldDef, type FieldOption, type FieldType, type Problem,
} from './validate';
import { STARTER_FIELDS } from './starters';

/**
 * Per-client custom lead fields (definitions). Each client has its own set (tenant RLS); values are saved on the lead and checked against
 * these definitions whenever a lead is saved (see validate.ts and LeadsService). Fields are hidden, never deleted, so no saved value is orphaned.
 */
export interface NewField {
  label: string;
  type: FieldType;
  key?: string;
  required?: boolean;
  options?: Array<string | { value?: string; label: string }>;
  defaultValue?: string | null;
  helpText?: string | null;
  showInList?: boolean;
}
export interface FieldPatch {
  label?: string;
  required?: boolean;
  visible?: boolean;
  options?: Array<string | { value?: string; label: string }>;
  defaultValue?: string | null;
  helpText?: string | null;
  showInList?: boolean;
}

const COLS = `id, field_key, label, field_type, is_required, is_visible, options, default_value, help_text, show_in_list, order_index`;
const toDef = (r: any): FieldDef => ({
  id: r.id,
  key: r.field_key,
  label: r.label,
  type: r.field_type,
  required: r.is_required,
  visible: r.is_visible,
  options: (r.options ?? []) as FieldOption[],
  defaultValue: r.default_value,
  helpText: r.help_text,
  showInList: r.show_in_list,
  order: r.order_index,
});

/** All definitions of a client's leads (visible and hidden), in display order. Used by lead saving and the exports. */
export async function loadFieldDefs(tx: pg.PoolClient, tenantId: string): Promise<FieldDef[]> {
  const { rows } = await tx.query(`SELECT ${COLS} FROM custom_field_definitions WHERE tenant_id = $1 AND entity_type = 'lead' ORDER BY is_visible DESC, order_index, created_at, id`, [tenantId]);
  return rows.map(toDef);
}

/** Insert one definition inside a tenant-scoped transaction. No permission check: callers authorise (API) or are trusted (starter fields, copy). */
export async function insertFieldDef(tx: pg.PoolClient, tenantId: string, input: NewField, existing?: FieldDef[]): Promise<FieldDef> {
  const defs = existing ?? (await loadFieldDefs(tx, tenantId));
  const problems: Problem[] = [];
  const label = input.label.trim();
  if (!label || label.length > 60) problems.push({ path: 'body.label', message: 'Give the field a name of up to 60 characters' });
  const isChoice = input.type === 'select' || input.type === 'multi_select';
  let options: FieldOption[] = [];
  if (isChoice) {
    const n = normalizeOptions(input.options ?? []);
    options = n.options;
    problems.push(...n.problems);
    if (!options.length) problems.push({ path: 'body.options', message: 'Add at least one option to choose from' });
  } else if (input.options?.length) problems.push({ path: 'body.options', message: 'Only dropdown fields have options' });

  const taken = new Set(defs.map((d) => d.key));
  if (input.key !== undefined) {
    if (!KEY_RE.test(input.key)) problems.push({ path: 'body.key', message: 'Use lowercase letters, digits and underscores, starting with a letter (40 characters at most)' });
    else if (taken.has(input.key)) throw Errors.conflict(`This client already has a field with the key “${input.key}”`);
  }
  if (defs.some((d) => d.visible && d.label.trim().toLowerCase() === label.toLowerCase())) throw Errors.conflict(`There is already a field called “${label}”`);
  if (defs.filter((d) => d.visible).length >= MAX_FIELDS_PER_CLIENT) throw Errors.unprocessable(`A client can have at most ${MAX_FIELDS_PER_CLIENT} custom fields. Hide one you no longer use.`);

  let defaultValue: string | null = null;
  if (input.defaultValue !== undefined && input.defaultValue !== null && input.defaultValue !== '') {
    const probe = normalizeValue({ type: input.type, options, label }, input.defaultValue);
    if (!probe.ok) problems.push({ path: 'body.defaultValue', message: probe.message });
    else defaultValue = Array.isArray(probe.value) ? probe.value.join(',') : probe.value === null ? null : String(probe.value);
  }
  if (problems.length) throw Errors.validation(problems);

  const key = input.key ?? fieldKeyFromLabel(label, taken);
  const order = defs.reduce((m, d) => Math.max(m, d.order), -1) + 1;
  const { rows } = await tx.query(
    `INSERT INTO custom_field_definitions (tenant_id, entity_type, name, label, field_key, field_type, is_required, is_visible, options, default_value, help_text, show_in_list, order_index)
     VALUES ($1,'lead',$2,$2,$3,$4::custom_field_type,$5,true,$6::jsonb,$7,$8,$9,$10) RETURNING ${COLS}`,
    [tenantId, label, key, input.type, input.required ?? false, JSON.stringify(options), defaultValue, input.helpText?.trim() || null, input.showInList ?? false, order]
  );
  return toDef(rows[0]);
}

/** Give a new client the starter fields of its industry (inside the client's own tenant-scoped transaction). */
export async function seedStarterFields(tx: pg.PoolClient, tenantId: string, industry: string): Promise<number> {
  const starters = STARTER_FIELDS[industry] ?? [];
  let defs = await loadFieldDefs(tx, tenantId);
  for (const s of starters) defs = [...defs, await insertFieldDef(tx, tenantId, { label: s.label, type: s.type, options: s.options, helpText: s.helpText }, defs)];
  return starters.length;
}

export class CustomFieldsService {
  constructor(private db: Database) {}

  async list(actor: Actor, opts: { includeHidden: boolean }): Promise<FieldDef[]> {
    assertCan(actor, 'custom_fields:read');
    return this.db.readTenant(actor, async (tx) => (await loadFieldDefs(tx, actor.tenantId)).filter((d) => opts.includeHidden || d.visible));
  }

  async create(actor: Actor, input: NewField): Promise<FieldDef> {
    assertCan(actor, 'custom_fields:manage');
    return this.db.withTenant(actor, async (tx) => {
      // One definition change at a time per client: the uniqueness and count checks below must not race.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('custom-fields:' || $1, 0))`, [actor.tenantId]);
      const def = await insertFieldDef(tx, actor.tenantId, input);
      await audit(tx, { action: 'custom_field.create', entityType: 'custom_field', entityId: def.id, after: { key: def.key, label: def.label, type: def.type, required: def.required } });
      return def;
    });
  }

  async update(actor: Actor, id: string, patch: FieldPatch): Promise<FieldDef> {
    assertCan(actor, 'custom_fields:manage');
    return this.db.withTenant(actor, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('custom-fields:' || $1, 0))`, [actor.tenantId]);
      const defs = await loadFieldDefs(tx, actor.tenantId);
      const cur = defs.find((d) => d.id === id);
      if (!cur) throw Errors.notFound('Field');
      const problems: Problem[] = [];
      const sets: string[] = [];
      const vals: unknown[] = [id, actor.tenantId];
      const set = (col: string, v: unknown, cast = '') => (vals.push(v), sets.push(`${col} = $${vals.length}${cast}`));
      const changed: string[] = [];

      if (patch.label !== undefined) {
        const label = patch.label.trim();
        if (!label || label.length > 60) problems.push({ path: 'body.label', message: 'Give the field a name of up to 60 characters' });
        else if (defs.some((d) => d.id !== id && d.visible && (patch.visible ?? cur.visible) && d.label.trim().toLowerCase() === label.toLowerCase())) throw Errors.conflict(`There is already a field called “${label}”`);
        else if (label !== cur.label) {
          set('label', label);
          set('name', label);
          changed.push('label');
        }
      }
      if (patch.required !== undefined && patch.required !== cur.required) {
        set('is_required', patch.required);
        changed.push('required');
      }
      if (patch.showInList !== undefined && patch.showInList !== cur.showInList) {
        set('show_in_list', patch.showInList);
        changed.push('showInList');
      }
      if (patch.helpText !== undefined) {
        set('help_text', patch.helpText?.trim() || null);
        changed.push('helpText');
      }
      if (patch.visible !== undefined && patch.visible !== cur.visible) {
        if (patch.visible) {
          if (defs.filter((d) => d.visible).length >= MAX_FIELDS_PER_CLIENT) throw Errors.unprocessable(`A client can have at most ${MAX_FIELDS_PER_CLIENT} custom fields.`);
          if (defs.some((d) => d.id !== id && d.visible && d.label.trim().toLowerCase() === (patch.label ?? cur.label).trim().toLowerCase())) throw Errors.conflict(`There is already a field called “${cur.label}”. Rename one of them first.`);
        }
        set('is_visible', patch.visible);
        changed.push(patch.visible ? 'shown' : 'hidden');
      }

      let options = cur.options;
      if (patch.options !== undefined) {
        if (cur.type !== 'select' && cur.type !== 'multi_select') problems.push({ path: 'body.options', message: 'Only dropdown fields have options' });
        else {
          // Existing options keep their stored value when sent again by name, so renaming or reordering never changes saved leads.
          const given = patch.options.map((o) => {
            if (typeof o !== 'string') return o;
            const same = cur.options.find((x) => x.label.toLowerCase() === o.trim().toLowerCase());
            return same ? { value: same.value, label: o } : o;
          });
          const n = normalizeOptions(given);
          problems.push(...n.problems);
          if (!n.options.length) problems.push({ path: 'body.options', message: 'Keep at least one option' });
          const removed = cur.options.filter((o) => !n.options.some((x) => x.value === o.value)).map((o) => o.value);
          if (removed.length && !problems.length) {
            const used = Number(
              (
                await tx.query(
                  `SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND (custom_fields ->> $2::text = ANY($3::text[])
                      OR (jsonb_typeof(custom_fields -> $2::text) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(custom_fields -> $2::text) e WHERE e = ANY($3::text[]))))`,
                  [actor.tenantId, cur.key, removed]
                )
              ).rows[0].n
            );
            if (used) throw Errors.conflict(`${used} lead${used === 1 ? ' uses' : 's use'} an option you removed. Rename it instead, or move those leads first.`);
          }
          if (!problems.length) {
            options = n.options;
            set('options', JSON.stringify(n.options), '::jsonb');
            changed.push('options');
          }
        }
      }
      if (patch.defaultValue !== undefined) {
        if (patch.defaultValue === null || patch.defaultValue === '') {
          set('default_value', null);
          changed.push('defaultValue');
        }
        else {
          const probe = normalizeValue({ type: cur.type, options, label: cur.label }, patch.defaultValue);
          if (!probe.ok) problems.push({ path: 'body.defaultValue', message: probe.message });
          else {
            set('default_value', Array.isArray(probe.value) ? probe.value.join(',') : String(probe.value));
            changed.push('defaultValue');
          }
        }
      }
      if (problems.length) throw Errors.validation(problems);
      if (!sets.length) return cur;
      const { rows } = await tx.query(`UPDATE custom_field_definitions SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING ${COLS}`, vals);
      await audit(tx, { action: 'custom_field.update', entityType: 'custom_field', entityId: id, after: { key: cur.key, fields: changed } });
      return toDef(rows[0]);
    });
  }

  async reorder(actor: Actor, ids: string[]): Promise<FieldDef[]> {
    assertCan(actor, 'custom_fields:manage');
    return this.db.withTenant(actor, async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('custom-fields:' || $1, 0))`, [actor.tenantId]);
      const defs = await loadFieldDefs(tx, actor.tenantId);
      const known = new Set(defs.map((d) => d.id));
      const unknown = ids.find((i) => !known.has(i));
      if (unknown) throw Errors.notFound('Field');
      if (new Set(ids).size !== ids.length) throw Errors.validation([{ path: 'body.ids', message: 'Each field can be listed once' }]);
      // Listed fields first in the given order, then the rest in their current order.
      const rest = defs.filter((d) => !ids.includes(d.id)).map((d) => d.id);
      const all = [...ids, ...rest];
      await tx.query(
        `UPDATE custom_field_definitions d SET order_index = o.pos FROM (SELECT unnest($2::uuid[]) AS id, generate_series(0, $3::int - 1) AS pos) o
          WHERE d.id = o.id AND d.tenant_id = $1`,
        [actor.tenantId, all, all.length]
      );
      await audit(tx, { action: 'custom_field.reorder', entityType: 'custom_field', entityId: actor.tenantId, after: { count: all.length } });
      return loadFieldDefs(tx, actor.tenantId);
    });
  }
}
