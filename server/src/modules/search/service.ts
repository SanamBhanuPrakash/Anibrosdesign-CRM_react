import type { Database } from '../../platform/db';
import { assertCan, scopeIfAllowed, type Actor } from '../../platform/authz/actor';
import { Errors } from '../../platform/errors';
import { escapeLike } from '../contacts/normalize';

/**
 * Global search (the ⌘K palette). One endpoint, five kinds of record, at most 5 of each, and ONLY what the caller may see:
 *   leads       leads:read      (sales agents: their own leads)
 *   contacts    contacts:read
 *   properties  properties:read
 *   projects    projects:read
 *   tasks       tasks:read      (sales agents: their own tasks)
 * Kinds a role may not read are absent from the answer (not empty), so the response itself reveals nothing about records the caller
 * cannot see. Matching is a literal case-insensitive "contains" (LIKE metacharacters are escaped) over names, e-mail, phone digits,
 * titles, places and unit numbers; archived records are never returned.
 */
export type SearchKind = 'leads' | 'contacts' | 'properties' | 'projects' | 'tasks';
export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}
export type SearchResults = Partial<Record<SearchKind, SearchHit[]>>;

const PER_KIND = 5;

export class SearchService {
  constructor(private db: Database) {}

  async search(actor: Actor, raw: string): Promise<{ query: string; results: SearchResults }> {
    assertCan(actor, 'search:use');
    const q = raw.trim().replace(/\s+/g, ' ');
    if (q.length < 2) throw Errors.validation([{ path: 'query.q', message: 'Type at least 2 characters' }]);
    const like = `%${escapeLike(q)}%`;
    const digits = q.replace(/\D/g, '');
    const phoneLike = digits.length >= 3 ? `%${digits}%` : null;

    return this.db.readTenant(actor, async (tx) => {
      const results: SearchResults = {};
      const t = actor.tenantId;

      const leadScope = scopeIfAllowed(actor, 'leads:read');
      if (leadScope) {
        const params: unknown[] = [t, like, phoneLike];
        let own = '';
        if (leadScope === 'own') {
          params.push(actor.userId);
          own = ` AND l.owner_id = $4`;
        }
        const { rows } = await tx.query(
          `SELECT l.id, c.display_name AS name, s.name AS stage, l.source::text AS source, l.campaign
             FROM leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id JOIN pipeline_stages s ON s.id = l.stage_id AND s.tenant_id = l.tenant_id
            WHERE l.tenant_id = $1 AND l.deleted_at IS NULL${own}
              AND (c.display_name ILIKE $2 OR c.email::text ILIKE $2 OR l.campaign ILIKE $2 OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $3))
            ORDER BY (l.closed_at IS NULL) DESC, l.created_at DESC, l.id LIMIT ${PER_KIND}`,
          params
        );
        results.leads = rows.map((r) => ({ id: r.id, title: r.name ?? 'Lead', subtitle: [r.stage, r.source?.replace(/_/g, ' '), r.campaign].filter(Boolean).join(' · '), href: `/leads/${r.id}` }));
      }

      if (scopeIfAllowed(actor, 'contacts:read')) {
        const { rows } = await tx.query(
          `SELECT c.id, c.display_name AS name, c.email::text AS email, c.phone, c.company
             FROM contacts c
            WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
              AND (c.display_name ILIKE $2 OR c.email::text ILIKE $2 OR c.company ILIKE $2 OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $3))
            ORDER BY c.display_name, c.id LIMIT ${PER_KIND}`,
          [t, like, phoneLike]
        );
        results.contacts = rows.map((r) => ({ id: r.id, title: r.name, subtitle: [r.company, r.email ?? r.phone].filter(Boolean).join(' · ') || null, href: `/contacts?c=${r.id}` }));
      }

      if (scopeIfAllowed(actor, 'properties:read')) {
        const { rows } = await tx.query(
          `SELECT p.id, p.title, p.status::text AS status, COALESCE(p.location, NULLIF(concat_ws(', ', p.locality, p.city), '')) AS place, p.unit_number
             FROM properties p
            WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
              AND (p.title ILIKE $2 OR p.locality ILIKE $2 OR p.city ILIKE $2 OR p.location ILIKE $2 OR p.unit_number ILIKE $2)
            ORDER BY p.created_at DESC, p.id LIMIT ${PER_KIND}`,
          [t, like]
        );
        results.properties = rows.map((r) => ({ id: r.id, title: r.title, subtitle: [r.unit_number ? `Unit ${r.unit_number}` : null, r.place, String(r.status).replace(/_/g, ' ')].filter(Boolean).join(' · '), href: `/properties/${r.id}` }));
      }

      if (scopeIfAllowed(actor, 'projects:read')) {
        const { rows } = await tx.query(
          `SELECT pr.id, pr.name, pr.city, pr.locality FROM projects pr
            WHERE pr.tenant_id = $1 AND pr.deleted_at IS NULL AND (pr.name ILIKE $2 OR pr.locality ILIKE $2 OR pr.city ILIKE $2)
            ORDER BY pr.name, pr.id LIMIT ${PER_KIND}`,
          [t, like]
        );
        results.projects = rows.map((r) => ({ id: r.id, title: r.name, subtitle: [r.locality, r.city].filter(Boolean).join(', ') || null, href: '/projects' }));
      }

      const taskScope = scopeIfAllowed(actor, 'tasks:read');
      if (taskScope) {
        const params: unknown[] = [t, like];
        let own = '';
        if (taskScope === 'own') {
          params.push(actor.userId);
          own = ` AND k.assigned_to = $3`;
        }
        const { rows } = await tx.query(
          `SELECT k.id, k.title, k.status::text AS status, k.due_date FROM tasks k
            WHERE k.tenant_id = $1 AND k.deleted_at IS NULL${own} AND k.title ILIKE $2
            ORDER BY (k.status IN ('pending','in_progress')) DESC, k.due_date NULLS LAST, k.id LIMIT ${PER_KIND}`,
          params
        );
        results.tasks = rows.map((r) => ({ id: r.id, title: r.title, subtitle: [String(r.status).replace(/_/g, ' '), r.due_date ? `due ${new Date(r.due_date).toISOString().slice(0, 10)}` : null].filter(Boolean).join(' · '), href: '/tasks' }));
      }
      return { query: q, results };
    });
  }
}
