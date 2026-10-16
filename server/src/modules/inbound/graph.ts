import crypto from 'crypto';

/**
 * Meta Graph lead retrieval.
 *
 * A Meta lead-ads webhook only carries ids (`leadgen_id`, `form_id`, `ad_id` …). The answers the person typed have to be
 * fetched with the page access token: GET /{leadgen_id}. Requests are signed with `appsecret_proof` (HMAC of the token with
 * the app secret) so a leaked token alone is useless, and have a hard timeout.
 *
 * Failures are classified so the worker knows what to do:
 *   TransientGraphError  network, 5xx, 429, Meta "temporarily unavailable"  → retry with backoff
 *   PermanentGraphError  bad/expired token, missing permission, lead deleted → the delivery needs a human (token fix), not retries
 */
export class TransientGraphError extends Error {}
export class PermanentGraphError extends Error {}

export interface GraphLead {
  id?: string;
  created_time?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
  field_data?: Array<{ name: string; values: string[] }>;
}

export interface MetaGraph {
  fetchLead(leadgenId: string, accessToken: string, appSecret: string): Promise<GraphLead>;
}

const FIELDS = 'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic,field_data';

/** Meta error codes that retrying cannot fix. */
const PERMANENT_CODES = new Set([100, 102, 190, 200, 10, 803, 2500]);

export class HttpMetaGraph implements MetaGraph {
  constructor(
    private baseUrl = process.env.META_GRAPH_BASE_URL ?? 'https://graph.facebook.com',
    private version = process.env.META_GRAPH_VERSION ?? 'v23.0',
    private timeoutMs = 8000
  ) {}

  async fetchLead(leadgenId: string, accessToken: string, appSecret: string): Promise<GraphLead> {
    if (!/^\d{5,40}$/.test(leadgenId)) throw new PermanentGraphError('The lead id from Meta is not a valid id');
    const proof = crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
    const url = new URL(`${this.baseUrl}/${this.version}/${leadgenId}`);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('appsecret_proof', proof);
    let res: Response;
    try {
      // Token travels in the Authorization header, never in the URL (URLs end up in logs).
      res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch (e: any) {
      throw new TransientGraphError(`Could not reach Meta (${e?.name === 'TimeoutError' ? 'timeout' : 'network'})`);
    }
    const body: any = await res.json().catch(() => null);
    if (res.ok && body && typeof body === 'object') return body as GraphLead;
    const code = Number(body?.error?.code);
    const msg = String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200);
    if (res.status === 429 || res.status >= 500 || [1, 2, 4, 17, 32, 341, 613].includes(code)) throw new TransientGraphError(`Meta is busy or unavailable: ${msg}`);
    if (PERMANENT_CODES.has(code) || res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) throw new PermanentGraphError(msg);
    throw new TransientGraphError(msg);
  }
}

let graph: MetaGraph = new HttpMetaGraph();
export const getMetaGraph = () => graph;
/** Tests inject a fake; production never calls this. */
export const setMetaGraph = (g: MetaGraph) => {
  graph = g;
};
