import crypto from 'crypto';
import type { Database } from '../../platform/db';
import { assertCan, type Actor } from '../../platform/authz/actor';
import { AppError, Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { getScanner, getStorage, safeFileName, sniff } from '../../platform/storage';
import { logger } from '../../logger';

export type FileEntity = 'property' | 'project';
const MAX_FILES_PER_ENTITY = 40;
const PERMS: Record<FileEntity, { read: 'properties:read' | 'projects:read'; write: 'properties:update' | 'projects:update' }> = {
  property: { read: 'properties:read', write: 'properties:update' },
  project: { read: 'projects:read', write: 'projects:update' },
};
const TABLE: Record<FileEntity, string> = { property: 'properties', project: 'projects' };

export interface FileDto {
  id: string;
  kind: 'image' | 'document';
  name: string;
  mime: string;
  sizeBytes: number;
  sortOrder: number;
  createdAt: string;
}

/**
 * Uploads: trust bytes, not headers. The declared type must agree with the sniffed signature, the size is capped before
 * buffering, the antivirus hook runs, content is de-duplicated per entity (same bytes twice → 409), and blob + row are
 * written so that a crash can only ever leave an orphan blob (harmless, swept by retention), never a row without bytes.
 */
export class FilesService {
  constructor(private db: Database) {}

  async list(actor: Actor, entity: FileEntity, entityId: string): Promise<FileDto[]> {
    assertCan(actor, PERMS[entity].read);
    return this.db.readTenant(actor, async (tx) => {
      await this.assertEntity(tx, actor.tenantId, entity, entityId);
      const { rows } = await tx.query(
        `SELECT id, kind, name, mime, size_bytes AS "sizeBytes", sort_order AS "sortOrder", created_at AS "createdAt" FROM files
          WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 AND deleted_at IS NULL ORDER BY sort_order, created_at`,
        [actor.tenantId, entity, entityId]
      );
      return rows as FileDto[];
    });
  }

  async upload(actor: Actor, entity: FileEntity, entityId: string, data: unknown, declaredMime: string | undefined, rawName: string | undefined): Promise<FileDto> {
    assertCan(actor, PERMS[entity].write);
    if (!Buffer.isBuffer(data) || data.length === 0) throw Errors.badRequest('Send the file as the request body with its Content-Type (image/jpeg, image/png, image/webp or application/pdf)');
    const type = sniff(data);
    if (!type) throw new AppError(415, 'BAD_REQUEST', 'Unsupported media type', { detail: 'Only JPEG, PNG, WebP images and PDF documents are accepted' });
    const declared = (declaredMime ?? '').split(';')[0]!.trim().toLowerCase();
    if (declared && declared !== 'application/octet-stream' && declared !== type.mime) throw Errors.validation([{ path: 'header.content-type', message: `The file contents are ${type.mime}, but the request says ${declared}` }]);
    const verdict = await getScanner().scan(data);
    if (!verdict.clean) throw Errors.unprocessable(`The file was rejected by the virus scan${verdict.reason ? `: ${verdict.reason}` : ''}`);

    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const now = new Date();
    const key = `${actor.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${type.ext}`;
    const name = safeFileName(rawName, `${type.kind}.${type.ext}`);
    const storage = getStorage();
    await storage.put(key, data);
    try {
      return await this.db.withTenant(actor, async (tx) => {
        await this.assertEntity(tx, actor.tenantId, entity, entityId, true);
        const n = await tx.query(`SELECT count(*)::int AS n, COALESCE(max(sort_order), -1) + 1 AS next FROM files WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 AND deleted_at IS NULL`, [actor.tenantId, entity, entityId]);
        if (n.rows[0].n >= MAX_FILES_PER_ENTITY) throw Errors.conflict(`At most ${MAX_FILES_PER_ENTITY} files per ${entity}. Delete some first.`);
        let row;
        try {
          row = (
            await tx.query(
              `INSERT INTO files (tenant_id, entity_type, entity_id, kind, name, mime, size_bytes, sha256, storage_key, sort_order, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, kind, name, mime, size_bytes AS "sizeBytes", sort_order AS "sortOrder", created_at AS "createdAt"`,
              [actor.tenantId, entity, entityId, type.kind, name, type.mime, data.length, sha256, key, n.rows[0].next, actor.userId]
            )
          ).rows[0] as FileDto;
        } catch (e: any) {
          if (e?.code === '23505' && e.constraint === 'uq_files_entity_content') throw Errors.conflict('This exact file is already attached');
          throw e;
        }
        // The first picture becomes the cover.
        if (type.kind === 'image' && entity === 'property') await tx.query('UPDATE properties SET cover_file_id = $3 WHERE id = $1 AND tenant_id = $2 AND cover_file_id IS NULL', [entityId, actor.tenantId, row.id]);
        await audit(tx, { action: 'file.upload', entityType: entity, entityId, after: { fileId: row.id, name, mime: type.mime, size: data.length } });
        await emit(tx, { type: entity === 'property' ? 'property.updated' : 'project.updated', aggregateId: entityId, payload: { files: true } });
        return row;
      });
    } catch (e) {
      await storage.delete(key).catch(() => undefined); // never keep bytes for an upload that was refused
      throw e;
    }
  }

  async setCover(actor: Actor, propertyId: string, fileId: string | null) {
    assertCan(actor, 'properties:update');
    return this.db.withTenant(actor, async (tx) => {
      await this.assertEntity(tx, actor.tenantId, 'property', propertyId, true);
      if (fileId) {
        const ok = await tx.query(`SELECT 1 FROM files WHERE id = $1 AND tenant_id = $2 AND entity_type = 'property' AND entity_id = $3 AND kind = 'image' AND deleted_at IS NULL`, [fileId, actor.tenantId, propertyId]);
        if (!ok.rowCount) throw Errors.validation([{ path: 'body.fileId', message: 'Choose one of this property’s pictures' }]);
      }
      await tx.query(`UPDATE properties SET cover_file_id = $3 WHERE id = $1 AND tenant_id = $2`, [propertyId, actor.tenantId, fileId]);
      await emit(tx, { type: 'property.updated', aggregateId: propertyId, payload: { cover: true } });
      return { coverFileId: fileId };
    });
  }

  async remove(actor: Actor, fileId: string): Promise<void> {
    const meta = await this.db.readTenant(actor, async (tx) => (await tx.query(`SELECT entity_type, entity_id FROM files WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [fileId, actor.tenantId])).rows[0]);
    if (!meta) throw Errors.notFound('File');
    assertCan(actor, PERMS[meta.entity_type as FileEntity].write);
    const key = await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE files SET deleted_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING storage_key, name`, [fileId, actor.tenantId]);
      if (!r.rows[0]) throw Errors.notFound('File');
      if (meta.entity_type === 'property') {
        // promote the next picture if the cover went away
        await tx.query(
          `UPDATE properties SET cover_file_id = (SELECT id FROM files WHERE tenant_id = $2 AND entity_type = 'property' AND entity_id = $1 AND kind = 'image' AND deleted_at IS NULL ORDER BY sort_order, created_at LIMIT 1)
            WHERE id = $1 AND tenant_id = $2 AND cover_file_id = $3`,
          [meta.entity_id, actor.tenantId, fileId]
        );
      }
      await audit(tx, { action: 'file.delete', entityType: meta.entity_type, entityId: meta.entity_id, before: { fileId, name: r.rows[0].name } });
      await emit(tx, { type: meta.entity_type === 'property' ? 'property.updated' : 'project.updated', aggregateId: meta.entity_id, payload: { files: true } });
      return r.rows[0].storage_key as string;
    });
    await getStorage().delete(key).catch((e) => logger.warn('Blob delete failed (retention will sweep it)', { fileId, error: String(e?.message ?? e) }));
  }

  /** Bytes for the download route. Authorisation follows the entity the file belongs to. */
  async read(actor: Actor, fileId: string): Promise<{ data: Buffer; mime: string; name: string; sha256: string }> {
    const meta = await this.db.readTenant(actor, async (tx) => (await tx.query(`SELECT entity_type, mime, name, sha256, storage_key FROM files WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [fileId, actor.tenantId])).rows[0]);
    if (!meta) throw Errors.notFound('File');
    assertCan(actor, PERMS[meta.entity_type as FileEntity].read);
    try {
      return { data: await getStorage().get(meta.storage_key), mime: meta.mime, name: meta.name, sha256: meta.sha256 };
    } catch {
      logger.error('File row exists but its bytes are missing', { fileId, tenantId: actor.tenantId });
      throw Errors.notFound('File');
    }
  }

  private async assertEntity(tx: import('pg').PoolClient, tenantId: string, entity: FileEntity, id: string, lock = false) {
    const r = await tx.query(`SELECT 1 FROM ${TABLE[entity]} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [id, tenantId]);
    if (!r.rowCount) throw Errors.notFound(entity === 'property' ? 'Property' : 'Project');
  }
}
