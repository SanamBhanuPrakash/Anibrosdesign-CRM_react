import { z } from 'zod';
import { defineRoute, created, noContent, paged, RawReply, Reply, ifMatchVersion, makeEtag, type RouteSpec } from '../../platform/http/route';
import { pageQuery } from '../../platform/http/pagination';
import { Errors } from '../../platform/errors';
import { FURNISHINGS, LISTING_TYPES, PROPERTY_STATUSES, PROPERTY_TYPES, STATUS_TRANSITIONS, type PropertiesService, type PropertyDto, type PropertyStatus } from './properties.service';
import { PROJECT_STATUSES, type ProjectsService } from './projects.service';
import type { FilesService } from './files.service';

const uuid = z.string().uuid();
const id = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max);
const money = z.number().min(0).max(1e13);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const list = (max: number, each: number) => z.array(text(each).min(1)).max(max);

export const PropertySchema = z.object({
  id: uuid,
  projectId: uuid.nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  propertyType: z.enum(PROPERTY_TYPES),
  listingType: z.enum(LISTING_TYPES),
  status: z.enum(PROPERTY_STATUSES),
  price: z.number(),
  currency: z.string(),
  pricePerSqft: z.number().nullable(),
  negotiable: z.boolean(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  areaSqft: z.number().nullable(),
  carpetAreaSqft: z.number().nullable(),
  unitNumber: z.string().nullable(),
  tower: z.string().nullable(),
  floor: z.number().int().nullable(),
  facing: z.string().nullable(),
  furnishing: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  locality: z.string().nullable(),
  location: z.string().nullable(),
  possessionDate: z.string().nullable(),
  reraId: z.string().nullable(),
  amenities: z.array(z.string()),
  tags: z.array(z.string()),
  ownerId: uuid.nullable(),
  ownerName: z.string().nullable(),
  coverFileId: uuid.nullable(),
  imageCount: z.number().int(),
  statusChangedAt: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ProjectSchema = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  developer: z.string().nullable(),
  city: z.string().nullable(),
  locality: z.string().nullable(),
  address: z.string().nullable(),
  reraId: z.string().nullable(),
  possessionDate: z.string().nullable(),
  amenities: z.array(z.string()),
  status: z.enum(PROJECT_STATUSES),
  units: z.object({ total: z.number().int(), available: z.number().int(), held: z.number().int(), closed: z.number().int(), inactive: z.number().int(), minPrice: z.number().nullable(), maxPrice: z.number().nullable(), availableValue: z.number() }),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const propertyFields = {
  projectId: uuid.nullish(),
  title: text(200).min(1, 'Give the property a title'),
  description: text(5000).nullish(),
  propertyType: z.enum(PROPERTY_TYPES).optional(),
  listingType: z.enum(LISTING_TYPES).optional(),
  price: money,
  currency: z.string().trim().length(3).optional(),
  negotiable: z.boolean().optional(),
  bedrooms: z.number().int().min(0).max(50).nullish(),
  bathrooms: z.number().int().min(0).max(50).nullish(),
  areaSqft: z.number().min(0).max(10_000_000).nullish().describe('Built-up / super area'),
  carpetAreaSqft: z.number().min(0).max(10_000_000).nullish(),
  unitNumber: text(40).nullish().describe('Unique within the project and tower'),
  tower: text(40).nullish(),
  floor: z.number().int().min(-5).max(200).nullish(),
  facing: text(40).nullish(),
  furnishing: z.enum(FURNISHINGS).nullish(),
  address: text(300).nullish(),
  city: text(100).nullish(),
  locality: text(100).nullish(),
  possessionDate: date.nullish(),
  reraId: text(60).nullish(),
  amenities: list(60, 60).optional(),
  tags: list(30, 40).optional(),
  ownerId: uuid.nullish().describe('Listing agent. Defaults to you.'),
};

const listQuery = pageQuery.extend({
  q: text(100).optional(),
  projectId: uuid.optional(),
  status: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
      const bad = parts.find((p) => !(PROPERTY_STATUSES as readonly string[]).includes(p));
      if (bad) ctx.addIssue({ code: 'custom', message: `Unknown status “${bad}”` });
      return parts as PropertyStatus[];
    })
    .describe('Comma-separated availability statuses'),
  propertyType: z.enum(PROPERTY_TYPES).optional(),
  listingType: z.enum(LISTING_TYPES).optional(),
  bedroomsMin: z.coerce.number().int().min(0).max(50).optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  areaMin: z.coerce.number().min(0).optional(),
  city: text(100).optional(),
  locality: text(100).optional(),
  ownerId: uuid.optional(),
  tag: text(40).optional(),
  sort: z.enum(['created', 'updated', 'price', 'area']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
const etag = (p: PropertyDto) => makeEtag(p.version, p.imageCount, p.coverFileId);

export function createPropertyRoutes(svc: PropertiesService, files: FilesService): RouteSpec[] {
  return [
    defineRoute({ method: 'get', path: '/', summary: 'List properties', description: 'Newest first by default. Archived properties are not listed.', tags: ['Properties'], permission: 'properties:read', query: listQuery, response: PropertySchema, paginated: true, handler: async ({ query, actor }) => { const r = await svc.list(actor, query); return paged(r.items, r.page); } }),
    defineRoute({ method: 'get', path: '/summary', summary: 'Inventory snapshot', description: 'Counts by availability and type, plus the value and average price per sq ft of what is available now.', tags: ['Properties'], permission: 'properties:read', handler: async ({ actor }) => svc.summary(actor) }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Create a property',
      description: 'A property is one sellable or rentable unit, optionally inside a project. Returns 409 when the unit number already exists in that project and tower. The first availability and price entries are recorded automatically.',
      tags: ['Properties'],
      permission: 'properties:create',
      idempotent: true,
      body: z.object(propertyFields),
      response: PropertySchema,
      handler: async ({ body, actor }) => { const p = await svc.create(actor, body); return created(p, etag(p)); },
    }),
    defineRoute({ method: 'get', path: '/:id', summary: 'Get a property', description: 'Includes pictures, documents, the price and availability history, and the availability changes allowed right now.', tags: ['Properties'], permission: 'properties:read', params: id, handler: async ({ params, actor }) => { const p = await svc.get(actor, params.id); return new Reply(p, 200, undefined, etag(p)); } }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update a property',
      description: 'Availability has its own endpoint because it follows rules. Price changes are recorded in the price history. Send `If-Match` to avoid overwriting a colleague’s edit.',
      tags: ['Properties'],
      permission: 'properties:update',
      params: id,
      body: z.object({ ...propertyFields, title: propertyFields.title.optional(), price: money.optional() }),
      response: PropertySchema,
      ifMatch: true,
      handler: async ({ params, body, actor, req }) => { const p = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match'))); return new Reply(p, 200, undefined, etag(p)); },
    }),
    defineRoute({
      method: 'post',
      path: '/:id/status',
      summary: 'Change availability',
      description: `Allowed moves: ${(Object.entries(STATUS_TRANSITIONS) as Array<[string, string[]]>).map(([f, t]) => `${f} → ${t.join(' | ')}`).join('; ')}. “sold” is for sale listings, “rented” for rent/lease. Reversing a sold or rented unit requires a reason. Every change is kept in the history.`,
      tags: ['Properties'],
      permission: 'properties:update',
      params: id,
      body: z.object({ status: z.enum(PROPERTY_STATUSES), reason: text(300).nullish() }),
      successStatus: 200,
      response: PropertySchema,
      handler: async ({ params, body, actor }) => svc.changeStatus(actor, params.id, body.status, body.reason),
    }),
    defineRoute({ method: 'delete', path: '/:id', summary: 'Archive a property', tags: ['Properties'], permission: 'properties:delete', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.archive(actor, params.id); return noContent(); } }),
    defineRoute({ method: 'post', path: '/:id/restore', summary: 'Restore an archived property', tags: ['Properties'], permission: 'properties:delete', params: id, successStatus: 200, response: PropertySchema, handler: async ({ params, actor }) => svc.restore(actor, params.id) }),
    defineRoute({ method: 'get', path: '/:id/files', summary: 'Pictures and documents of a property', tags: ['Properties'], permission: 'properties:read', params: id, handler: async ({ params, actor }) => files.list(actor, 'property', params.id) }),
    defineRoute({
      method: 'post',
      path: '/:id/files',
      summary: 'Upload a picture or document',
      description: 'Send the file itself as the request body with its Content-Type (JPEG, PNG, WebP or PDF, up to 10 MB). Pass the original name in `?name=`. The bytes are checked, not just the header; the same file twice is refused. The first picture becomes the cover.',
      tags: ['Properties'],
      permission: 'properties:update',
      params: id,
      query: z.object({ name: text(200).optional() }),
      rawBody: { limit: '10mb', description: 'The file bytes' },
      handler: async ({ params, query, req, actor }) => created(await files.upload(actor, 'property', params.id, req.body, req.get('content-type'), query.name)),
    }),
    defineRoute({
      method: 'put',
      path: '/:id/cover',
      summary: 'Choose the cover picture',
      tags: ['Properties'],
      permission: 'properties:update',
      params: id,
      body: z.object({ fileId: uuid.nullable() }),
      handler: async ({ params, body, actor }) => files.setCover(actor, params.id, body.fileId),
    }),
  ];
}

export function createProjectRoutes(svc: ProjectsService, files: FilesService): RouteSpec[] {
  const fields = {
    name: text(150).min(1, 'Give the project a name'),
    description: text(5000).nullish(),
    developer: text(150).nullish(),
    city: text(100).nullish(),
    locality: text(100).nullish(),
    address: text(300).nullish(),
    reraId: text(60).nullish(),
    possessionDate: date.nullish(),
    amenities: list(60, 60).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
  };
  const etag = (p: { version: number }) => makeEtag(p.version);
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'List projects with availability',
      description: 'Each project carries live unit counts (available, held, closed) and the price range of what is available.',
      tags: ['Projects'],
      permission: 'projects:read',
      query: pageQuery.extend({ q: text(100).optional(), status: z.enum(PROJECT_STATUSES).optional(), city: text(100).optional(), sort: z.enum(['name', 'created']).default('name'), order: z.enum(['asc', 'desc']).default('asc') }),
      response: ProjectSchema,
      paginated: true,
      handler: async ({ query, actor }) => { const r = await svc.list(actor, query); return paged(r.items, r.page); },
    }),
    defineRoute({ method: 'post', path: '/', summary: 'Create a project', tags: ['Projects'], permission: 'projects:create', idempotent: true, body: z.object(fields), response: ProjectSchema, handler: async ({ body, actor }) => { const p = await svc.create(actor, body); return created(p, etag(p)); } }),
    defineRoute({ method: 'get', path: '/:id', summary: 'Get a project', tags: ['Projects'], permission: 'projects:read', params: id, response: ProjectSchema, handler: async ({ params, actor }) => { const p = await svc.get(actor, params.id); return new Reply(p, 200, undefined, etag(p)); } }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Update a project',
      tags: ['Projects'],
      permission: 'projects:update',
      params: id,
      body: z.object({ ...fields, name: fields.name.optional() }),
      response: ProjectSchema,
      ifMatch: true,
      handler: async ({ params, body, actor, req }) => { const p = await svc.update(actor, params.id, body, ifMatchVersion(req.get('if-match'))); return new Reply(p, 200, undefined, etag(p)); },
    }),
    defineRoute({ method: 'delete', path: '/:id', summary: 'Archive a project', description: 'Refused while the project still has properties.', tags: ['Projects'], permission: 'projects:delete', params: id, successStatus: 204, handler: async ({ params, actor }) => { await svc.archive(actor, params.id); return noContent(); } }),
    defineRoute({ method: 'get', path: '/:id/files', summary: 'Brochures and pictures of a project', tags: ['Projects'], permission: 'projects:read', params: id, handler: async ({ params, actor }) => files.list(actor, 'project', params.id) }),
    defineRoute({
      method: 'post',
      path: '/:id/files',
      summary: 'Upload a brochure or picture',
      description: 'Same rules as property files: the bytes are sniffed, 10 MB maximum, duplicates refused.',
      tags: ['Projects'],
      permission: 'projects:update',
      params: id,
      query: z.object({ name: text(200).optional() }),
      rawBody: { limit: '10mb', description: 'The file bytes' },
      handler: async ({ params, query, req, actor }) => created(await files.upload(actor, 'project', params.id, req.body, req.get('content-type'), query.name)),
    }),
  ];
}

export function createFileRoutes(files: FilesService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/:id',
      summary: 'Download a file',
      description: 'Streams the file with its true type, `nosniff` and a sandboxing CSP. Browsers revalidate cheaply (ETag = content hash).',
      tags: ['Files'],
      permission: [],
      params: id,
      responseContentType: 'application/octet-stream',
      handler: async ({ params, actor, req }) => {
        const f = await files.read(actor, params.id);
        const etagValue = `"${f.sha256.slice(0, 32)}"`;
        if (req.get('if-none-match') === etagValue) return new RawReply('', f.mime, { ETag: etagValue, 'Cache-Control': 'private, no-cache' }, 304);
        return new RawReply(f.data, f.mime, {
          ETag: etagValue,
          'Cache-Control': 'private, no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'Cross-Origin-Resource-Policy': 'same-site',
          'Content-Disposition': `inline; filename="${f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        });
      },
    }),
    defineRoute({ method: 'delete', path: '/:id', summary: 'Delete a file', tags: ['Files'], permission: [], params: id, successStatus: 204, handler: async ({ params, actor }) => { await files.remove(actor, params.id); return noContent(); } }),
  ];
}

void Errors;
