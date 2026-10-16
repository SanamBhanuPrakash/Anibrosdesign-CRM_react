import { config } from '../../platform/config';

/**
 * WhatsApp Business Cloud API (Meta), one client's own number. Sending only: replies from people arrive through the lead's normal
 * channels for now.
 *
 * WhatsApp's own rule: free text may only be sent within 24 hours of the person's last message to the business. Outside that window only a
 * pre-approved template can start the conversation, so the API accepts either `text` or `template`, and explains the error in plain words.
 */
export class WhatsAppError extends Error {
  constructor(message: string, readonly permanent: boolean, readonly code?: number) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

const EXPLAIN: Record<number, { message: string; permanent: boolean }> = {
  190: { message: 'WhatsApp rejected the access token. It has expired or was revoked: connect the number again with a new token.', permanent: true },
  131047: { message: 'WhatsApp only allows free text within 24 hours of the person’s last message. Send an approved template instead.', permanent: true },
  131026: { message: 'That phone number is not on WhatsApp, or has not accepted WhatsApp’s terms.', permanent: true },
  131030: { message: 'That number is not on the list of allowed test recipients for this WhatsApp number.', permanent: true },
  132001: { message: 'That template does not exist (or not in that language). Check its exact name in WhatsApp Manager.', permanent: true },
  132000: { message: 'The number of values does not match what the template expects.', permanent: true },
  130429: { message: 'WhatsApp is slowing this number down (rate limit). It will be retried.', permanent: false },
  131056: { message: 'Too many messages to this person in a short time. It will be retried.', permanent: false },
};

export interface WhatsAppSend {
  phoneNumberId: string;
  token: string;
  /** Any phone format; reduced to digits. */
  to: string;
  text?: string;
  template?: { name: string; language: string; params?: string[] };
}

const digits = (p: string) => p.replace(/\D/g, '');

export async function sendWhatsApp(m: WhatsAppSend): Promise<{ messageId: string }> {
  const to = digits(m.to);
  if (to.length < 8 || to.length > 15) throw new WhatsAppError('That phone number does not look like a full international number. Add the country code.', true);
  const payload = m.template
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: m.template.name, language: { code: m.template.language }, ...(m.template.params?.length ? { components: [{ type: 'body', parameters: m.template.params.map((text) => ({ type: 'text', text })) }] } : {}) } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: m.text ?? '', preview_url: false } };
  let res: Response;
  try {
    res = await fetch(`${config.WHATSAPP_GRAPH_URL.replace(/\/$/, '')}/${encodeURIComponent(m.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${m.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    throw new WhatsAppError(`Could not reach WhatsApp: ${String((e as Error)?.message ?? e).slice(0, 120)}`, false);
  }
  const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } };
  if (res.ok && json.messages?.[0]?.id) return { messageId: json.messages[0].id };
  const code = json.error?.code;
  const known = code !== undefined ? EXPLAIN[code] : undefined;
  const permanent = known ? known.permanent : res.status >= 400 && res.status < 500 && res.status !== 429;
  throw new WhatsAppError(known?.message ?? `WhatsApp refused the message${json.error?.message ? `: ${json.error.message.slice(0, 160)}` : ` (${res.status})`}`, permanent, code);
}

/** Asks WhatsApp who this number is. Used when connecting: a wrong id or token fails here, not on the first real message. */
export async function checkWhatsAppAccount(phoneNumberId: string, token: string): Promise<{ displayPhone: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${config.WHATSAPP_GRAPH_URL.replace(/\/$/, '')}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new WhatsAppError(`Could not reach WhatsApp: ${String((e as Error)?.message ?? e).slice(0, 120)}`, false);
  }
  const json = (await res.json().catch(() => ({}))) as { display_phone_number?: string; error?: { message?: string; code?: number } };
  if (!res.ok) throw new WhatsAppError(json.error?.code !== undefined && EXPLAIN[json.error.code] ? EXPLAIN[json.error.code]!.message : 'WhatsApp did not accept this phone number id and token. Copy both again from Meta’s WhatsApp setup page.', true, json.error?.code);
  return { displayPhone: json.display_phone_number ?? null };
}
