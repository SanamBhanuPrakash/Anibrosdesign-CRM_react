import type pg from 'pg';
import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';

export type LeadStatus = 'open' | 'contacted' | 'qualified' | 'viewing_scheduled' | 'negotiation' | 'won' | 'lost' | 'disqualified';
export const CLOSED_STATUSES: readonly LeadStatus[] = ['won', 'lost', 'disqualified'];
export const isClosedStatus = (s: string) => (CLOSED_STATUSES as readonly string[]).includes(s);

/** Lead fields a transition may demand before the lead may enter a stage. */
export const GATE_FIELDS = ['ownerId', 'estimatedValue', 'budgetMax', 'phone', 'email', 'nextFollowupAt'] as const;
export type GateField = (typeof GATE_FIELDS)[number];

export interface StageDto {
  id: string;
  name: string;
  stageKey: string;
  orderIndex: number;
  color: string;
  mapsToStatus: LeadStatus;
  probability: number;
  isClosed: boolean;
  leadCount: number;
}
export interface PipelineDto {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  /** Lost and Not a fit need a reason code (the recommended pipeline); otherwise a written reason is enough. */
  reasonCodesRequired: boolean;
  /** Won needs a recorded deal value tied to a unit (decision D3). On in the recommended pipeline. */
  dealValueRequired: boolean;
  /** 'beginner_v1' when created from the recommended pipeline, null for pipelines built by hand or before the recommendation existed. */
  template: string | null;
  stages: StageDto[];
}
export interface TransitionDto {
  fromStageId: string;
  toStageId: string;
  requiredFields: GateField[];
}

export interface StageInput {
  name: string;
  color?: string;
  mapsToStatus?: LeadStatus;
  probability?: number;
}

const STANDARD_STAGES: Array<Required<StageInput> & { key: string }> = [
  { key: 'new', name: 'New', color: '#6F86A3', mapsToStatus: 'open', probability: 5 },
  { key: 'contacted', name: 'Contacted', color: '#8A7F5C', mapsToStatus: 'contacted', probability: 15 },
  { key: 'qualified', name: 'Qualified', color: '#6B8F71', mapsToStatus: 'qualified', probability: 30 },
  { key: 'negotiation', name: 'Negotiation', color: '#9A7B6B', mapsToStatus: 'negotiation', probability: 70 },
  { key: 'won', name: 'Won', color: '#2E7D4F', mapsToStatus: 'won', probability: 100 },
  { key: 'lost', name: 'Lost', color: '#B3382C', mapsToStatus: 'lost', probability: 0 },
];

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'stage';

/**
 * Own-scope visibility for lead aggregates: sales agents only ever count their own leads, plus the ones they were added to as a handler.
 * Returns an SQL predicate on alias `l` (pushing params), or `false` when the actor may not read leads at all.
 */
export function leadVisibility(actor: Actor, alias: string, params: unknown[]): string | false {
  if (actor.kind === 'system') return 'true';
  const scope = scopeIfAllowed(actor, 'leads:read');
  if (!scope) return false;
  if (scope === 'all') return 'true';
  params.push(actor.userId);
  const me = `$${params.length}`;
  return `(${alias}.owner_id = ${me} OR EXISTS (SELECT 1 FROM lead_handlers lh WHERE lh.lead_id = ${alias}.id AND lh.tenant_id = ${alias}.tenant_id AND lh.user_id = ${me}))`;
}

export class PipelinesService {
  constructor(private db: Database) {}

  async list(actor: Actor): Promise<PipelineDto[]> {
    assertCan(actor, 'pipeline:read');
    return this.db.readTenant(actor, async (tx) => this.loadAll(tx, actor));
  }

  async get(actor: Actor, id: string): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:read');
    return this.db.readTenant(actor, async (tx) => {
      const p = (await this.loadAll(tx, actor, id))[0];
      if (!p) throw Errors.notFound('Pipeline');
      return p;
    });
  }

  async create(actor: Actor, input: { name: string; description?: string | null; copyFromId?: string; empty?: boolean }): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      const count = await tx.query(`SELECT count(*)::int AS n FROM pipelines WHERE tenant_id = $1 AND archived_at IS NULL`, [actor.tenantId]);
      if (count.rows[0].n >= 20) throw Errors.conflict('A workspace can have at most 20 pipelines');
      const first = count.rows[0].n === 0;
      const ins = await tx.query(`INSERT INTO pipelines (tenant_id, name, description, is_default) VALUES ($1,$2,$3,$4) RETURNING id`, [actor.tenantId, input.name.trim(), input.description?.trim() || null, first]);
      const id = ins.rows[0].id as string;

      let stages: Array<Required<StageInput> & { key: string }> = STANDARD_STAGES;
      if (input.copyFromId) {
        const src = await tx.query(
          `SELECT name, stage_key AS key, color, maps_to_status AS "mapsToStatus", probability FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL ORDER BY order_index`,
          [input.copyFromId, actor.tenantId]
        );
        if (!src.rowCount) throw Errors.notFound('Pipeline to copy');
        stages = src.rows as typeof stages;
      }
      if (!input.empty) {
        for (const [i, s] of stages.entries()) {
          await tx.query(
            `INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color, maps_to_status, probability) VALUES ($1,$2,$3,$4,$5,$6,$7::lead_status,$8)`,
            [actor.tenantId, id, s.name, s.key ?? slug(s.name), i, s.color, s.mapsToStatus, s.probability]
          );
        }
      }
      const dto = (await this.loadAll(tx, actor, id))[0]!;
      await audit(tx, { action: 'pipeline.create', entityType: 'pipeline', entityId: id, after: { name: dto.name, stages: dto.stages.map((s) => s.name) } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: id });
      return dto;
    });
  }

  async update(actor: Actor, id: string, patch: { name?: string; description?: string | null; isDefault?: boolean; reasonCodesRequired?: boolean; dealValueRequired?: boolean }): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT id, is_default FROM pipelines WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      if (!cur.rows[0]) throw Errors.notFound('Pipeline');
      if (patch.isDefault === false && cur.rows[0].is_default) throw Errors.conflict('Choose another pipeline as the default instead');
      if (patch.isDefault) {
        await tx.query(`UPDATE pipelines SET is_default = false WHERE tenant_id = $1 AND is_default AND id <> $2`, [actor.tenantId, id]);
      }
      await tx.query(
        `UPDATE pipelines SET name = COALESCE($3, name), description = CASE WHEN $4::boolean THEN $5 ELSE description END, is_default = COALESCE($6, is_default), reason_codes_required = COALESCE($7, reason_codes_required), deal_value_required = COALESCE($8, deal_value_required) WHERE id = $1 AND tenant_id = $2`,
        [id, actor.tenantId, patch.name?.trim() ?? null, patch.description !== undefined, patch.description?.trim() || null, patch.isDefault ?? null, patch.reasonCodesRequired ?? null, patch.dealValueRequired ?? null]
      );
      await audit(tx, { action: 'pipeline.update', entityType: 'pipeline', entityId: id, after: patch });
      await emit(tx, { type: 'pipeline.updated', aggregateId: id });
      return (await this.loadAll(tx, actor, id))[0]!;
    });
  }

  /**
   * Add the recommended beginner pipeline to an EXISTING workspace (decision D7). It never replaces or edits anything: it adds a second
   * pipeline. Existing leads stay where they are; `makeDefault` only decides where NEW leads start. Safe to repeat (the second call returns
   * the pipeline that was already added) and audited.
   */
  async applyRecommended(actor: Actor, opts: { makeDefault?: boolean }): Promise<{ pipeline: PipelineDto; created: boolean }> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      const had = (await tx.query(`SELECT id FROM pipelines WHERE tenant_id = $1 AND template = 'beginner_v1' AND archived_at IS NULL`, [actor.tenantId])).rows[0];
      if (had) {
        if (opts.makeDefault) await this.makeDefaultInTx(tx, actor, had.id);
        return { pipeline: (await this.loadAll(tx, actor, had.id))[0]!, created: false };
      }
      const count = (await tx.query(`SELECT count(*)::int AS n FROM pipelines WHERE tenant_id = $1 AND archived_at IS NULL`, [actor.tenantId])).rows[0].n as number;
      if (count >= 20) throw Errors.conflict('A workspace can have at most 20 pipelines');
      const id = (await tx.query(`SELECT app.seed_beginner_pipeline($1, $2, $3) AS id`, [actor.tenantId, 'Recommended pipeline', Boolean(opts.makeDefault) || count === 0])).rows[0].id as string;
      await audit(tx, { action: 'pipeline.apply_recommended', entityType: 'pipeline', entityId: id, after: { template: 'beginner_v1', madeDefault: Boolean(opts.makeDefault) || count === 0 } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: id });
      return { pipeline: (await this.loadAll(tx, actor, id))[0]!, created: true };
    });
  }

  private async makeDefaultInTx(tx: pg.PoolClient, actor: Actor, id: string) {
    const cur = (await tx.query(`SELECT is_default FROM pipelines WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, actor.tenantId])).rows[0];
    if (cur?.is_default) return;
    await tx.query(`UPDATE pipelines SET is_default = false WHERE tenant_id = $1 AND is_default AND id <> $2`, [actor.tenantId, id]);
    await tx.query(`UPDATE pipelines SET is_default = true WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
    await audit(tx, { action: 'pipeline.update', entityType: 'pipeline', entityId: id, after: { isDefault: true } });
    await emit(tx, { type: 'pipeline.updated', aggregateId: id });
  }

  async archive(actor: Actor, id: string): Promise<void> {
    assertCan(actor, 'pipeline:manage');
    await this.db.withTenant(actor, async (tx) => {
      const cur = await tx.query(`SELECT is_default FROM pipelines WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL FOR UPDATE`, [id, actor.tenantId]);
      if (!cur.rows[0]) throw Errors.notFound('Pipeline');
      if (cur.rows[0].is_default) throw Errors.conflict('The default pipeline cannot be archived. Make another pipeline the default first.');
      const open = await tx.query(`SELECT count(*)::int AS n FROM leads WHERE pipeline_id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND closed_at IS NULL`, [id, actor.tenantId]);
      if (open.rows[0].n > 0) throw Errors.conflict(`This pipeline still has ${open.rows[0].n} open lead${open.rows[0].n === 1 ? '' : 's'}. Move or close them first.`);
      await tx.query(`UPDATE pipelines SET archived_at = now() WHERE id = $1 AND tenant_id = $2`, [id, actor.tenantId]);
      await audit(tx, { action: 'pipeline.archive', entityType: 'pipeline', entityId: id });
      await emit(tx, { type: 'pipeline.updated', aggregateId: id });
    });
  }

  // ── stages ──────────────────────────────────────────────────────────────────────────────────────────

  async addStage(actor: Actor, pipelineId: string, input: StageInput & { afterStageId?: string | null }): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      const order = await this.lockPipelineStages(tx, actor, pipelineId);
      if (order.length >= 25) throw Errors.conflict('A pipeline can have at most 25 stages');
      const existingKeys = new Set((await tx.query(`SELECT stage_key FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [pipelineId, actor.tenantId])).rows.map((r) => r.stage_key));
      let key = slug(input.name);
      for (let n = 2; existingKeys.has(key); n++) key = `${slug(input.name).slice(0, 36)}_${n}`;
      const status = input.mapsToStatus ?? 'open';
      const ins = await tx.query(
        `INSERT INTO pipeline_stages (tenant_id, pipeline_id, name, stage_key, order_index, color, maps_to_status, probability)
         VALUES ($1,$2,$3,$4,$5,$6,$7::lead_status,$8) RETURNING id`,
        [actor.tenantId, pipelineId, input.name.trim(), key, order.length, input.color ?? '#7C8C8A', status, this.probabilityFor(status, input.probability)]
      );
      const ids = order.map((o) => o.id);
      const at = input.afterStageId ? ids.indexOf(input.afterStageId) + 1 : ids.length;
      if (input.afterStageId && at === 0) throw Errors.validation([{ path: 'body.afterStageId', message: 'Unknown stage' }]);
      ids.splice(at, 0, ins.rows[0].id);
      await this.applyOrder(tx, actor, pipelineId, ids);
      await this.assertShape(tx, actor, pipelineId);
      await audit(tx, { action: 'pipeline.stage_add', entityType: 'pipeline', entityId: pipelineId, after: { name: input.name, status } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: pipelineId });
      return (await this.loadAll(tx, actor, pipelineId))[0]!;
    });
  }

  async updateStage(actor: Actor, pipelineId: string, stageId: string, patch: Partial<StageInput>): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      await this.lockPipelineStages(tx, actor, pipelineId);
      const cur = await tx.query(`SELECT maps_to_status AS status, probability FROM pipeline_stages WHERE id = $1 AND pipeline_id = $2 AND tenant_id = $3 AND archived_at IS NULL FOR UPDATE`, [stageId, pipelineId, actor.tenantId]);
      if (!cur.rows[0]) throw Errors.notFound('Stage');
      const status = (patch.mapsToStatus ?? cur.rows[0].status) as LeadStatus;
      const probability = patch.probability ?? (patch.mapsToStatus ? this.probabilityFor(status, undefined) : cur.rows[0].probability);
      await tx.query(
        `UPDATE pipeline_stages SET name = COALESCE($4, name), color = COALESCE($5, color), maps_to_status = $6::lead_status, probability = $7 WHERE id = $1 AND pipeline_id = $2 AND tenant_id = $3`,
        [stageId, pipelineId, actor.tenantId, patch.name?.trim() ?? null, patch.color ?? null, status, this.probabilityFor(status, probability)]
      );
      // Leads sitting in the stage must follow its new meaning (status / closed_at are derived from the stage).
      if (status !== cur.rows[0].status) {
        await tx.query(
          `UPDATE leads SET status = $3::lead_status, closed_at = CASE WHEN $3::lead_status IN ('won','lost','disqualified') THEN COALESCE(closed_at, now()) ELSE NULL END,
                  loss_reason = CASE WHEN $3::lead_status IN ('won','lost','disqualified') THEN loss_reason ELSE NULL END
            WHERE stage_id = $1 AND tenant_id = $2`,
          [stageId, actor.tenantId, status]
        );
      }
      await this.assertShape(tx, actor, pipelineId);
      await audit(tx, { action: 'pipeline.stage_update', entityType: 'pipeline', entityId: pipelineId, after: { stageId, ...patch } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: pipelineId });
      return (await this.loadAll(tx, actor, pipelineId))[0]!;
    });
  }

  async archiveStage(actor: Actor, pipelineId: string, stageId: string, moveLeadsTo?: string): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      const order = await this.lockPipelineStages(tx, actor, pipelineId);
      if (!order.some((o) => o.id === stageId)) throw Errors.notFound('Stage');
      if (order.length <= 2) throw Errors.conflict('A pipeline needs at least two stages');
      const used = await tx.query(`SELECT count(*)::int AS n FROM leads WHERE stage_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [stageId, actor.tenantId]);
      if (used.rows[0].n > 0) {
        if (!moveLeadsTo) throw Errors.conflict(`${used.rows[0].n} lead${used.rows[0].n === 1 ? ' is' : 's are'} in this stage. Choose a stage to move them to.`, { extensions: { reason: 'stage_in_use', leadCount: used.rows[0].n } });
        if (moveLeadsTo === stageId || !order.some((o) => o.id === moveLeadsTo)) throw Errors.validation([{ path: 'body.moveLeadsTo', message: 'Choose a different stage of this pipeline' }]);
        await tx.query(
          `INSERT INTO lead_stage_history (lead_id, tenant_id, from_stage_id, to_stage_id, changed_by, reason)
           SELECT id, tenant_id, stage_id, $3, $4, 'Stage removed from pipeline' FROM leads WHERE stage_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [stageId, actor.tenantId, moveLeadsTo, actor.userId]
        );
        await tx.query(`UPDATE leads SET stage_id = $3 WHERE stage_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [stageId, actor.tenantId, moveLeadsTo]);
      }
      await tx.query(`UPDATE pipeline_stages SET archived_at = now() WHERE id = $1 AND tenant_id = $2`, [stageId, actor.tenantId]);
      await tx.query(`DELETE FROM pipeline_stage_transitions WHERE pipeline_id = $1 AND tenant_id = $2 AND (from_stage_id = $3 OR to_stage_id = $3)`, [pipelineId, actor.tenantId, stageId]);
      await this.applyOrder(tx, actor, pipelineId, order.map((o) => o.id).filter((i) => i !== stageId));
      await this.assertShape(tx, actor, pipelineId);
      await audit(tx, { action: 'pipeline.stage_archive', entityType: 'pipeline', entityId: pipelineId, after: { stageId, moveLeadsTo } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: pipelineId });
      return (await this.loadAll(tx, actor, pipelineId))[0]!;
    });
  }

  async reorder(actor: Actor, pipelineId: string, stageIds: string[]): Promise<PipelineDto> {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      const order = await this.lockPipelineStages(tx, actor, pipelineId);
      const have = new Set(order.map((o) => o.id));
      if (stageIds.length !== have.size || new Set(stageIds).size !== stageIds.length || stageIds.some((i) => !have.has(i))) {
        throw Errors.validation([{ path: 'body.stageIds', message: 'List every stage of the pipeline exactly once' }]);
      }
      await this.applyOrder(tx, actor, pipelineId, stageIds);
      await this.assertShape(tx, actor, pipelineId);
      await audit(tx, { action: 'pipeline.reorder', entityType: 'pipeline', entityId: pipelineId, after: { stageIds } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: pipelineId });
      return (await this.loadAll(tx, actor, pipelineId))[0]!;
    });
  }

  // ── transition matrix ───────────────────────────────────────────────────────────────────────────────

  /** `restricted: false` ⇒ no rules stored ⇒ any stage may follow any other. */
  async transitions(actor: Actor, pipelineId: string): Promise<{ restricted: boolean; transitions: TransitionDto[] }> {
    assertCan(actor, 'pipeline:read');
    return this.db.readTenant(actor, async (tx) => {
      if (!(await tx.query(`SELECT 1 FROM pipelines WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [pipelineId, actor.tenantId])).rowCount) throw Errors.notFound('Pipeline');
      const { rows } = await tx.query(
        `SELECT t.from_stage_id AS "fromStageId", t.to_stage_id AS "toStageId", t.required_fields AS "requiredFields"
           FROM pipeline_stage_transitions t
           JOIN pipeline_stages f ON f.id = t.from_stage_id AND f.archived_at IS NULL
           JOIN pipeline_stages s ON s.id = t.to_stage_id AND s.archived_at IS NULL
          WHERE t.pipeline_id = $1 AND t.tenant_id = $2 AND t.is_allowed ORDER BY f.order_index, s.order_index`,
        [pipelineId, actor.tenantId]
      );
      return { restricted: rows.length > 0, transitions: rows as TransitionDto[] };
    });
  }

  async setTransitions(actor: Actor, pipelineId: string, input: { restricted: boolean; transitions: TransitionDto[] }) {
    assertCan(actor, 'pipeline:manage');
    return this.db.withTenant(actor, async (tx) => {
      await this.lockPipelineStages(tx, actor, pipelineId);
      const byId = new Map((await tx.query(`SELECT id, stage_key FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [pipelineId, actor.tenantId])).rows.map((r) => [r.id as string, r.stage_key as string]));
      if (input.restricted) {
        if (!input.transitions.length) throw Errors.validation([{ path: 'body.transitions', message: 'A restricted pipeline needs at least one allowed move (or switch to “any stage to any stage”)' }]);
        const seen = new Set<string>();
        for (const [i, t] of input.transitions.entries()) {
          if (!byId.has(t.fromStageId) || !byId.has(t.toStageId) || t.fromStageId === t.toStageId) throw Errors.validation([{ path: `body.transitions.${i}`, message: 'Both stages must belong to this pipeline and differ' }]);
          const k = `${t.fromStageId}>${t.toStageId}`;
          if (seen.has(k)) throw Errors.validation([{ path: `body.transitions.${i}`, message: 'Duplicate move' }]);
          seen.add(k);
        }
      }
      await tx.query(`DELETE FROM pipeline_stage_transitions WHERE pipeline_id = $1 AND tenant_id = $2`, [pipelineId, actor.tenantId]);
      if (input.restricted) {
        for (const t of input.transitions) {
          await tx.query(
            `INSERT INTO pipeline_stage_transitions (tenant_id, pipeline_id, from_stage_id, to_stage_id, from_stage_key, to_stage_key, is_allowed, required_fields)
             VALUES ($1,$2,$3,$4,$5,$6,true,$7::text[])`,
            [actor.tenantId, pipelineId, t.fromStageId, t.toStageId, byId.get(t.fromStageId), byId.get(t.toStageId), [...new Set(t.requiredFields)]]
          );
        }
      }
      await audit(tx, { action: 'pipeline.transitions', entityType: 'pipeline', entityId: pipelineId, after: { restricted: input.restricted, count: input.transitions.length } });
      await emit(tx, { type: 'pipeline.updated', aggregateId: pipelineId });
      return { restricted: input.restricted, transitions: input.restricted ? input.transitions : [] };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────────

  private probabilityFor(status: LeadStatus, requested: number | undefined): number {
    if (status === 'won') return 100;
    if (status === 'lost' || status === 'disqualified') return 0;
    return Math.min(99, Math.max(0, Math.round(requested ?? 0)));
  }

  private async lockPipelineStages(tx: pg.PoolClient, actor: Actor, pipelineId: string) {
    const p = await tx.query(`SELECT id FROM pipelines WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL FOR UPDATE`, [pipelineId, actor.tenantId]);
    if (!p.rowCount) throw Errors.notFound('Pipeline');
    const { rows } = await tx.query(`SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL ORDER BY order_index, created_at, id`, [pipelineId, actor.tenantId]);
    return rows as Array<{ id: string }>;
  }

  private async applyOrder(tx: pg.PoolClient, actor: Actor, pipelineId: string, ids: string[]) {
    await tx.query(
      `UPDATE pipeline_stages s SET order_index = o.pos FROM (SELECT id, (ord - 1)::int AS pos FROM unnest($3::uuid[]) WITH ORDINALITY AS t(id, ord)) o
        WHERE s.id = o.id AND s.pipeline_id = $1 AND s.tenant_id = $2`,
      [pipelineId, actor.tenantId, ids]
    );
  }

  /** Invariants every pipeline keeps: ≥ 2 stages, the entry stage is not a closing one, and there is a way to win and a way to lose. */
  private async assertShape(tx: pg.PoolClient, actor: Actor, pipelineId: string) {
    const { rows } = await tx.query(`SELECT maps_to_status AS status FROM pipeline_stages WHERE pipeline_id = $1 AND tenant_id = $2 AND archived_at IS NULL ORDER BY order_index`, [pipelineId, actor.tenantId]);
    if (rows.length < 2) throw Errors.conflict('A pipeline needs at least two stages');
    if (isClosedStatus(rows[0].status)) throw Errors.conflict('The first stage cannot be a closing stage (won, lost or disqualified)');
    const statuses = new Set(rows.map((r) => r.status));
    if (!statuses.has('won')) throw Errors.conflict('A pipeline needs a stage that means “won”');
    if (!statuses.has('lost') && !statuses.has('disqualified')) throw Errors.conflict('A pipeline needs a stage that means “lost”');
  }

  private async loadAll(tx: pg.PoolClient, actor: Actor, onlyId?: string): Promise<PipelineDto[]> {
    const params: unknown[] = [actor.tenantId];
    const vis = leadVisibility(actor, 'l', params);
    const idFilter = onlyId ? (params.push(onlyId), `AND p.id = $${params.length}`) : '';
    const counts = vis === false ? '0' : `(SELECT count(*)::int FROM leads l WHERE l.stage_id = s.id AND l.tenant_id = s.tenant_id AND l.deleted_at IS NULL AND ${vis})`;
    const { rows } = await tx.query(
      `SELECT p.id AS "pipelineId", p.name AS "pipelineName", p.description, p.is_default AS "isDefault", p.reason_codes_required AS "reasonCodesRequired", p.deal_value_required AS "dealValueRequired", p.template,
              s.id AS "stageId", s.name AS "stageName", s.stage_key AS "stageKey", s.order_index AS "orderIndex", s.color,
              s.maps_to_status AS "mapsToStatus", s.probability, ${counts} AS "leadCount"
         FROM pipelines p LEFT JOIN pipeline_stages s ON s.pipeline_id = p.id AND s.tenant_id = p.tenant_id AND s.archived_at IS NULL
        WHERE p.tenant_id = $1 AND p.archived_at IS NULL ${idFilter}
        ORDER BY p.is_default DESC, p.created_at, p.id, s.order_index`,
      params
    );
    const out = new Map<string, PipelineDto>();
    for (const r of rows) {
      const p: PipelineDto = out.get(r.pipelineId) ?? { id: r.pipelineId, name: r.pipelineName, description: r.description, isDefault: r.isDefault, reasonCodesRequired: r.reasonCodesRequired, dealValueRequired: r.dealValueRequired, template: r.template, stages: [] };
      if (r.stageId) {
        p.stages.push({ id: r.stageId, name: r.stageName, stageKey: r.stageKey, orderIndex: r.orderIndex, color: r.color, mapsToStatus: r.mapsToStatus, probability: r.probability, isClosed: isClosedStatus(r.mapsToStatus), leadCount: r.leadCount });
      }
      out.set(r.pipelineId, p);
    }
    return [...out.values()];
  }
}
