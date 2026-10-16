import type pg from 'pg';
import type { Database } from '../../platform/db';
import type { Actor } from '../../platform/authz/actor';
import { assignableRoles, isRole, type Role } from '../../platform/authz/matrix';
import { Errors } from '../../platform/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/events';
import { enqueueMail } from '../../platform/mail';
import { generateToken, hashToken, type SessionService } from '../identity/sessions';
import { hashPassword } from '../identity/passwords';
import { passwordProblems } from '../identity/password-policy';

const INVITE_TTL_MS = 7 * 86_400_000;

export interface MemberRow {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  joinedAt: string;
  mfaEnabled: boolean;
  lastSeenAt: string | null;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export class MembersService {
  constructor(
    private db: Database,
    private sessions: SessionService
  ) {}

  /** id + display name only: enough for assignee pickers, nothing sensitive. */
  async directory(actor: Actor) {
    return this.db.readTenant(actor, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id AS "userId", u.name, tm.role FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
          WHERE tm.tenant_id = $1 AND tm.status = 'active' AND tm.is_active AND u.is_active ORDER BY u.name`,
        [actor.tenantId]
      );
      return rows as Array<{ userId: string; name: string; role: Role }>;
    });
  }

  async list(actor: Actor): Promise<{ members: MemberRow[]; invitations: InvitationRow[] }> {
    return this.db.readTenant(actor, async (tx) => {
      const members = await tx.query(
        `SELECT tm.id AS "membershipId", u.id AS "userId", u.name, u.email, tm.role, tm.status, tm.created_at AS "joinedAt",
                COALESCE(sec.mfa_enabled, false) AS "mfaEnabled", sec.last_seen_at AS "lastSeenAt"
           FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
           LEFT JOIN app.member_security($1::uuid) sec ON sec.user_id = u.id
          WHERE tm.tenant_id = $1 AND tm.status IN ('active', 'suspended')
          ORDER BY tm.created_at`,
        [actor.tenantId]
      );
      const invitations = await tx.query(
        `SELECT id, email, role, invited_by AS "invitedBy", expires_at AS "expiresAt", created_at AS "createdAt"
           FROM tenant_invitations WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC`,
        [actor.tenantId]
      );
      return { members: members.rows as MemberRow[], invitations: invitations.rows as InvitationRow[] };
    });
  }

  private assertCanGrant(actor: Actor, role: Role) {
    if (!assignableRoles(actor.role).includes(role)) throw Errors.forbidden(`Your role cannot grant "${role}"`);
  }

  async invite(actor: Actor, input: { email: string; role: Role }, actorName: string) {
    this.assertCanGrant(actor, input.role);
    const email = input.email.trim().toLowerCase();
    const token = generateToken(32);
    return this.db.withTenant(actor, async (tx) => {
      const existing = await tx.query(
        `SELECT 1 FROM tenant_memberships tm JOIN users u ON u.id = tm.user_id
          WHERE tm.tenant_id = $1 AND u.email = $2 AND tm.status IN ('active', 'suspended')`,
        [actor.tenantId, email]
      );
      if (existing.rowCount) throw Errors.conflict('This person is already a member of the workspace');

      // Re-inviting replaces any pending invitation to the same address (one live invitation per email).
      await tx.query(`UPDATE tenant_invitations SET revoked_at = now() WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [actor.tenantId, email]);
      const ins = await tx.query(
        `INSERT INTO tenant_invitations (tenant_id, email, role, invited_by, token_hash, expires_at)
         VALUES ($1, $2, $3::tenant_role, $4, $5, $6) RETURNING id, email, role, expires_at AS "expiresAt"`,
        [actor.tenantId, email, input.role, actor.userId, hashToken(token), new Date(Date.now() + INVITE_TTL_MS)]
      );
      const tenant = await tx.query(`SELECT name FROM tenants WHERE id = $1`, [actor.tenantId]);
      await enqueueMail(tx, {
        template: 'invitation',
        to: email,
        token,
        data: { tenantName: tenant.rows[0].name, inviterName: actorName, role: input.role },
      });
      await audit(tx, { action: 'member.invite', entityType: 'invitation', entityId: ins.rows[0].id, after: { email, role: input.role } });
      await emit(tx, { type: 'member.invited', aggregateId: ins.rows[0].id, payload: { role: input.role } });
      return ins.rows[0] as { id: string; email: string; role: Role; expiresAt: string };
    });
  }

  async revokeInvitation(actor: Actor, id: string) {
    await this.db.withTenant(actor, async (tx) => {
      const r = await tx.query(`UPDATE tenant_invitations SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email, role`, [id, actor.tenantId]);
      if (!r.rowCount) throw Errors.notFound('Invitation');
      await audit(tx, { action: 'member.invitation_revoke', entityType: 'invitation', entityId: id, before: r.rows[0] });
    });
  }

  /**
   * Guard shared by role changes and removals: the workspace must always keep at least one active owner, even under
   * concurrent requests (lock every owner row before counting).
   */
  private async lockOwners(tx: pg.PoolClient, tenantId: string): Promise<number> {
    const r = await tx.query(`SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND role = 'tenant_owner' AND status = 'active' FOR UPDATE`, [tenantId]);
    return r.rowCount ?? 0;
  }

  async update(actor: Actor, membershipId: string, patch: { role?: Role; status?: 'active' | 'suspended' }) {
    if (patch.role) this.assertCanGrant(actor, patch.role);
    return this.db.withTenant(actor, async (tx) => {
      const owners = await this.lockOwners(tx, actor.tenantId);
      const cur = await tx.query(`SELECT id, user_id, role, status FROM tenant_memberships WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [membershipId, actor.tenantId]);
      const m = cur.rows[0];
      if (!m || m.status === 'revoked') throw Errors.notFound('Member');
      if (m.role === 'tenant_owner' && actor.role !== 'tenant_owner') throw Errors.forbidden('Only an owner can change an owner');
      const losingOwner = m.role === 'tenant_owner' && ((patch.role && patch.role !== 'tenant_owner') || patch.status === 'suspended');
      if (losingOwner && owners <= 1) throw Errors.conflict('A workspace must keep at least one active owner');

      const up = await tx.query(
        `UPDATE tenant_memberships SET role = COALESCE($3::tenant_role, role), status = COALESCE($4::membership_status, status), updated_by = $5
          WHERE id = $1 AND tenant_id = $2 RETURNING id AS "membershipId", user_id AS "userId", role, status`,
        [membershipId, actor.tenantId, patch.role ?? null, patch.status ?? null, actor.userId]
      );
      await audit(tx, { action: 'member.update', entityType: 'membership', entityId: membershipId, before: { role: m.role, status: m.status }, after: { role: up.rows[0].role, status: up.rows[0].status } });
      await emit(tx, { type: 'member.updated', aggregateId: membershipId, payload: { role: up.rows[0].role, status: up.rows[0].status } });
      return up.rows[0] as { membershipId: string; userId: string; role: Role; status: string };
    });
  }

  async remove(actor: Actor, membershipId: string) {
    await this.db.withTenant(actor, async (tx) => {
      const owners = await this.lockOwners(tx, actor.tenantId);
      const cur = await tx.query(`SELECT id, user_id, role, status FROM tenant_memberships WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [membershipId, actor.tenantId]);
      const m = cur.rows[0];
      if (!m || m.status === 'revoked') throw Errors.notFound('Member');
      if (m.role === 'tenant_owner' && actor.role !== 'tenant_owner') throw Errors.forbidden('Only an owner can remove an owner');
      if (m.role === 'tenant_owner' && owners <= 1) throw Errors.conflict('A workspace must keep at least one active owner');
      await tx.query(`UPDATE tenant_memberships SET status = 'revoked', is_active = false, updated_by = $3 WHERE id = $1 AND tenant_id = $2`, [membershipId, actor.tenantId, actor.userId]);
      // Their sessions that point at this workspace keep working elsewhere; authenticate() re-checks membership every request.
      await tx.query(`SELECT app.detach_sessions($1::uuid, $2::uuid)`, [actor.tenantId, m.user_id]);
      await audit(tx, { action: 'member.remove', entityType: 'membership', entityId: membershipId, before: { role: m.role } });
      await emit(tx, { type: 'member.updated', aggregateId: membershipId, payload: { status: 'revoked' } });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Invitation acceptance (public; runs before tenant context exists)
  // ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Look up an invitation to show "X invited you to Y" before acceptance. Reveals only what the link holder needs. */
  async preview(token: string) {
    const { rows } = await this.db.identity.query(`SELECT * FROM app.resolve_invitation($1)`, [hashToken(token)]);
    const i = rows[0];
    if (!i || i.accepted_at || i.revoked_at || new Date(i.expires_at) < new Date()) throw Errors.notFound('Invitation');
    const exists = await this.db.identity.query(`SELECT 1 FROM users WHERE email = $1`, [i.email]);
    return { email: i.email as string, tenantName: i.tenant_name as string, role: i.role as Role, accountExists: (exists.rowCount ?? 0) > 0 };
  }

  /** Accept as an already-signed-in user whose email matches the invitation. */
  async acceptAsExistingUser(token: string, user: { id: string; email: string }) {
    return this.db.identity.tx(async (tx) => {
      const inv = await tx.query(`SELECT * FROM app.consume_invitation($1, $2)`, [hashToken(token), user.email]);
      if (!inv.rowCount) throw Errors.notFound('Invitation'); // wrong mailbox, expired, used or revoked — indistinguishable on purpose
      const i = inv.rows[0];
      await this.addMembership(tx, i.tenant_id, user.id, i.role, i.invited_by);
      return { tenantId: i.tenant_id as string };
    });
  }

  /** Accept as a brand-new user: the invitation proves mailbox ownership, so the address is verified immediately. */
  async acceptAsNewUser(token: string, input: { name: string; password: string }, meta: { ip?: string; userAgent?: string }) {
    const pre = await this.preview(token);
    if (pre.accountExists) throw Errors.conflict('An account with this email already exists. Sign in to accept the invitation.', { extensions: { code: 'LOGIN_REQUIRED' } });
    const problems = passwordProblems(input.password, { email: pre.email, name: input.name });
    if (problems.length) throw Errors.validation(problems.map((m) => ({ path: 'password', message: m })));
    const passwordHash = await hashPassword(input.password);

    const userId = await this.db.identity.tx(async (tx) => {
      const inv = await tx.query(`SELECT * FROM app.consume_invitation($1, $2)`, [hashToken(token), pre.email]);
      if (!inv.rowCount) throw Errors.notFound('Invitation');
      const i = inv.rows[0];
      const u = await tx.query(`INSERT INTO users (email, password_hash, name, email_verified) VALUES ($1, $2, $3, true) ON CONFLICT (email) DO NOTHING RETURNING id`, [pre.email, passwordHash, input.name.trim()]);
      if (!u.rowCount) throw Errors.conflict('An account with this email already exists. Sign in to accept the invitation.');
      await this.addMembership(tx, i.tenant_id, u.rows[0].id, i.role, i.invited_by);
      return u.rows[0].id as string;
    });
    const created = await this.sessions.create(userId, { ip: meta.ip, userAgent: meta.userAgent });
    const session = await this.sessions.validate(created.token);
    return { token: created.token, expiresAt: created.expiresAt, session: session! };
  }

  private async addMembership(tx: pg.PoolClient, tenantId: string, userId: string, role: Role, invitedBy: string | null) {
    if (!isRole(role)) throw Errors.internal();
    await tx.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, is_active, invited_by)
       VALUES ($1, $2, $3::tenant_role, 'active', true, $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', is_active = true, invited_by = EXCLUDED.invited_by`,
      [tenantId, userId, role, invitedBy]
    );
    // Audit + event inside the new member's tenant context
    await tx.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true)`, [tenantId, userId]);
    await audit(tx, { action: 'member.join', entityType: 'membership', entityId: userId, after: { role } });
    await emit(tx, { type: 'member.updated', aggregateId: userId, payload: { role, status: 'active' } });
  }
}
