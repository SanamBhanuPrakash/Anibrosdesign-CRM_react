import { z } from 'zod';
import { defineRoute, type RouteSpec } from '../../platform/http/route';
import type { SearchService } from './service';

const Hit = z.object({ id: z.string(), title: z.string(), subtitle: z.string().nullable(), href: z.string().describe('In-app path to open') });

export function createSearchRoutes(svc: SearchService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Search leads, contacts, properties, projects and tasks',
      description:
        'At most 5 hits per kind, only kinds and records the caller may see (a salesperson finds their own leads and tasks; a kind they cannot read is absent from the answer). ' +
        'Case-insensitive “contains” over names, e-mail, phone digits, titles, places and unit numbers. At least 2 characters. Archived records are never returned.',
      tags: ['Search'],
      permission: 'search:use',
      query: z.object({ q: z.string().max(100) }),
      response: z.object({
        query: z.string(),
        results: z.object({ leads: z.array(Hit), contacts: z.array(Hit), properties: z.array(Hit), projects: z.array(Hit), tasks: z.array(Hit) }).partial(),
      }),
      handler: async ({ query, actor }) => svc.search(actor, query.q),
    }),
  ];
}
