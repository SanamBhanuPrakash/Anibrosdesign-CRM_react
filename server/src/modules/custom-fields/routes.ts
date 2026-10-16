import { z } from 'zod';
import { created, defineRoute, type RouteSpec } from '../../platform/http/route';
import type { CustomFieldsService } from './service';
import { FIELD_TYPES } from './validate';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().max(max);
const optionInput = z.union([text(80).min(1), z.object({ value: z.string().regex(/^[a-z0-9][a-z0-9_]{0,39}$/).optional(), label: text(80).min(1) })]);

export const FieldSchema = z.object({
  id: uuid,
  key: z.string().describe('Stable identifier; this is the key under `customFields` on a lead. Never changes'),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  visible: z.boolean().describe('Hidden fields keep their saved values but accept no new ones'),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  defaultValue: z.string().nullable(),
  helpText: z.string().nullable(),
  showInList: z.boolean(),
  order: z.number().int(),
});

export function createCustomFieldRoutes(svc: CustomFieldsService): RouteSpec[] {
  return [
    defineRoute({
      method: 'get',
      path: '/',
      summary: 'Custom lead fields of this workspace',
      description: 'Each client has its own fields. Visible fields only by default.',
      tags: ['Custom fields'],
      permission: 'custom_fields:read',
      query: z.object({ includeHidden: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }),
      response: z.array(FieldSchema),
      handler: async ({ query, actor }) => svc.list(actor, query),
    }),
    defineRoute({
      method: 'post',
      path: '/',
      summary: 'Add a custom lead field',
      description:
        'Types: text, number, date (YYYY-MM-DD), boolean, select, multi_select, url, email. Dropdown types need `options` (names, or `{value,label}`). The `key` is generated from the label unless given and can never be changed. A client can have 50 fields.',
      tags: ['Custom fields'],
      permission: 'custom_fields:manage',
      body: z.object({
        label: text(60).min(1, 'Give the field a name'),
        type: z.enum(FIELD_TYPES),
        key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Lowercase letters, digits and underscores, starting with a letter').optional(),
        required: z.boolean().optional().describe('People saving a lead must fill it in. Automatic intake (ad forms, imports) is not held to it'),
        options: z.array(optionInput).max(50).optional(),
        defaultValue: text(500).nullish(),
        helpText: text(200).nullish(),
        showInList: z.boolean().optional(),
      }),
      response: FieldSchema,
      handler: async ({ body, actor }) => created(await svc.create(actor, body)),
    }),
    defineRoute({
      method: 'patch',
      path: '/:id',
      summary: 'Change a custom lead field',
      description:
        'Rename, make required, hide or show, change dropdown options, set a default. The key and the type never change. Removing an option that leads still use is refused (rename it instead). Hiding keeps every saved value.',
      tags: ['Custom fields'],
      permission: 'custom_fields:manage',
      params: z.object({ id: uuid }),
      body: z
        .object({
          label: text(60).min(1).optional(),
          required: z.boolean().optional(),
          visible: z.boolean().optional(),
          options: z.array(optionInput).max(50).optional(),
          defaultValue: text(500).nullish(),
          helpText: text(200).nullish(),
          showInList: z.boolean().optional(),
        })
        .strict(),
      response: FieldSchema,
      handler: async ({ params, body, actor }) => svc.update(actor, params.id, body),
    }),
    defineRoute({
      method: 'put',
      path: '/order',
      summary: 'Set the order of the fields',
      description: 'The listed fields come first in this order, the rest follow as they were.',
      tags: ['Custom fields'],
      permission: 'custom_fields:manage',
      body: z.object({ ids: z.array(uuid).max(100) }),
      response: z.array(FieldSchema),
      handler: async ({ body, actor }) => svc.reorder(actor, body.ids),
    }),
  ];
}
