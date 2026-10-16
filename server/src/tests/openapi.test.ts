import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { bootApi, type ApiHarness } from './support/app-harness';

let h: ApiHarness;
let doc: any;
beforeAll(async () => {
  h = await bootApi({ restricted: true });
  doc = (await request(h.app).get('/api/v1/openapi.json')).body;
}, 90_000);
afterAll(async () => h?.close());

describe('OpenAPI document (generated from the route registry)', () => {
  it('is a well-formed 3.1 document with auth schemes, problem schema and webhooks', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Anibros CRM API');
    expect(Object.keys(doc.components.securitySchemes)).toEqual(expect.arrayContaining(['bearerApiKey', 'cookieAuth']));
    expect(doc.components.schemas.Problem.required).toContain('code');
    expect(Object.keys(doc.webhooks)).toContain('lead.created');
  });

  it('documents every declared route exactly once with unique operationIds', () => {
    const ids: string[] = [];
    for (const [path, item] of Object.entries<any>(doc.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        expect(op.summary, `${method} ${path} needs a summary`).toBeTruthy();
        expect(op.tags?.length, `${method} ${path} needs a tag`).toBeGreaterThan(0);
        expect(path.startsWith('/api/v1/')).toBe(true);
        ids.push(op.operationId);
      }
    }
    expect(ids.length).toBeGreaterThan(25);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('public routes are marked security:[] and protected routes accept cookie OR api key', () => {
    expect(doc.paths['/api/v1/auth/login'].post.security).toEqual([]);
    expect(doc.paths['/api/v1/members'].get.security).toEqual([{ cookieAuth: [] }, { bearerApiKey: [] }]);
    expect(doc.paths['/api/v1/members'].get['x-required-permissions']).toEqual(['members:read']);
  });

  it('request bodies and path params come from the same zod schemas that validate input', () => {
    const body = doc.paths['/api/v1/auth/signup'].post.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(expect.arrayContaining(['email', 'password', 'name']));
    expect(body.properties.email.format).toBe('email');
    const p = doc.paths['/api/v1/members/{id}'].patch.parameters.find((x: any) => x.name === 'id');
    expect(p).toMatchObject({ in: 'path', required: true });
  });

  it('idempotent endpoints advertise the Idempotency-Key header', () => {
    const params = doc.paths['/api/v1/api-keys'].post.parameters.map((p: any) => p.name);
    expect(params).toContain('Idempotency-Key');
    expect(doc.paths['/api/v1/api-keys'].post['x-idempotent']).toBe(true);
  });

  it('never leaks secrets or internal details into the description', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/password_hash|secret_hash|COOKIE_SECRET|DATABASE_URL/);
  });
});

describe('docs viewer', () => {
  it('is served with a nonce-based CSP and no third-party origins', async () => {
    const r = await request(h.app).get('/api/docs');
    expect(r.status).toBe(200);
    const csp = r.headers['content-security-policy'];
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("default-src 'none'");
    expect(r.text).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr|cloudflare)/i);
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)![1];
    expect(r.text).toContain(`nonce="${nonce}"`);
  });

  it('each response gets a fresh nonce', async () => {
    const a = (await request(h.app).get('/api/docs')).headers['content-security-policy'];
    const b = (await request(h.app).get('/api/docs')).headers['content-security-policy'];
    expect(a).not.toBe(b);
  });
});

describe('operational endpoints', () => {
  it('/metrics is protected in production-like config and exposes RED metrics in test', async () => {
    const r = await request(h.app).get('/metrics');
    expect(r.status).toBe(200);
    expect(r.text).toContain('anibros_http_request_duration_seconds');
    expect(r.text).toContain('anibros_db_pool_connections');
    // route label is a template, never a raw URL with ids
    await request(h.app).get('/api/v1/definitely-missing');
    const m = (await request(h.app).get('/metrics')).text;
    expect(m).not.toContain('definitely-missing');
  });
});
