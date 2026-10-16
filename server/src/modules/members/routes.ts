import { z } from 'zod';
import { defineRoute, created, noContent, type RouteSpec } from '../../platform/http/route';
import { ROLES } from '../../platform/authz/matrix';
import { Errors } from '../../platform/errors';
import { setCsrfCookie } from '../../middleware/csrf';
import { setSessionCookie } from '../identity/sessions';
import type { MembersService } from './service';

const role = z.enum(ROLES);
const id = z.object({ id: z.string().uuid() });

export function createMemberRoutes(svc: MembersService) {
  const members: RouteSpec[] = [
    defineRoute({
      method: 'get',
      path: '/directory',
      summary: 'Workspace directory (id, name, role)',
      description: 'Minimal list for assignee pickers. Available to every role that can work with leads or tasks.',
      tags: ['Members'],
      permission: 'members:directory',
      handler: async ({ actor }) => svc.directory(actor),
    }),
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List members and pending invitations',
      tags: ['Members'],
      permission: 'members:read',
      handler: async ({ actor }) => svc.list(actor),
    }),
    defineRoute({
      method: 'post',
      path: '/invitations',
      summary: 'Invite someone to the workspace',
      description: 'Sends an email with a 7-day, single-use link bound to the invited address. A role can only be granted by someone who may grant it (admins cannot grant owner).',
      tags: ['Members'],
      permission: 'members:invite',
      idempotent: true,
      body: z.object({ email: z.string().trim().toLowerCase().email().max(254), role }),
      handler: async ({ body, actor, req }) => created(await svc.invite(actor, body, req.auth?.session?.user.name ?? 'A teammate')),
    }),
    defineRoute({
      method: 'delete',
      path: '/invitations/:id',
      summary: 'Revoke a pending invitation',
      tags: ['Members'],
      permission: 'members:invite',
      params: id,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.revokeInvitation(actor, params.id);
        return noContent();
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Change a member’s role or suspend/reactivate them',
      description: 'The workspace always keeps at least one active owner, even under concurrent requests.',
      tags: ['Members'],
      permission: 'members:update',
      params: id,
      body: z.object({ role: role.optional(), status: z.enum(['active', 'suspended']).optional() }).refine((b) => b.role || b.status, { message: 'Provide role or status' }),
      handler: async ({ params, body, actor }) => svc.update(actor, params.id, body),
    }),
    defineRoute({
      method: 'delete',
      path: '/:id',
      summary: 'Remove a member from the workspace',
      tags: ['Members'],
      permission: 'members:remove',
      params: id,
      successStatus: 204,
      handler: async ({ params, actor }) => {
        await svc.remove(actor, params.id);
        return noContent();
      },
    }),
  ];

  /** Public acceptance endpoints (the link holder is not signed in / has no workspace yet). */
  const invitations: RouteSpec[] = [
    defineRoute({
      method: 'post',
      path: '/preview',
      auth: 'public',
      summary: 'Preview an invitation',
      description: 'Returns the workspace name, role and whether an account already exists for the invited address.',
      tags: ['Invitations'],
      body: z.object({ token: z.string().min(20).max(200) }),
      successStatus: 200,
      handler: async ({ body }) => svc.preview(body.token),
    }),
    defineRoute({
      method: 'post',
      path: '/accept',
      auth: 'public',
      summary: 'Accept an invitation',
      description:
        'If the invited address has no account, provide `name` and `password` to create one (the address is marked verified). If an account exists, call this while signed in as that exact user; the invitation is bound to its email.',
      tags: ['Invitations'],
      body: z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(2).max(100).optional(), password: z.string().min(1).max(128).optional() }),
      successStatus: 200,
      handler: async ({ body, req, res }) => {
        const meta = { ip: req.ip, userAgent: req.get('user-agent') };
        const sessionUser = await currentUser(req);
        if (sessionUser) {
          // Someone else is signed in in this browser (typical when testing an invite as the owner). Say so, instead of the generic
          // "not found" the mailbox check would produce. preview() still answers 404 for invalid tokens, so nothing new is revealed:
          // the link holder already sees the invited address.
          const pre = await svc.preview(body.token);
          if (pre.email.toLowerCase() !== sessionUser.email.toLowerCase()) {
            throw Errors.conflict(`You are signed in as ${sessionUser.email}, but this invitation is for ${pre.email}. Sign out, then open the invitation link again.`, { extensions: { code: 'WRONG_ACCOUNT' } });
          }
          const r = await svc.acceptAsExistingUser(body.token, sessionUser);
          return { status: 'joined' as const, tenantId: r.tenantId };
        }
        if (!body.name || !body.password) throw Errors.badRequest('Provide name and password to create your account, or sign in first if you already have one');
        const r = await svc.acceptAsNewUser(body.token, { name: body.name, password: body.password }, meta);
        setSessionCookie(res, r.token, r.expiresAt);
        return { status: 'account_created' as const, csrfToken: setCsrfCookie(res), activeTenantId: r.session.activeTenantId };
      },
    }),
  ];

  return { members, invitations };
}

// The accept endpoint is public but must recognise a signed-in user; resolved lazily to avoid a circular import.
async function currentUser(req: import('express').Request) {
  const { sessions } = await import('../../container');
  const { sessionCookieName } = await import('../identity/sessions');
  const s = await sessions.validate(req.cookies?.[sessionCookieName()]);
  return s ? { id: s.user.id, email: s.user.email } : null;
}
