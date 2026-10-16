import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  BadPayload, extractEvents, honeypotTripped, normalizeLead, parseBody, parseMoney, signGeneric, verifyGenericSignature, verifyGoogleKey, verifyMetaSignature,
} from '../modules/inbound/providers';

const meta = (raw: string, secret: string) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('signatures', () => {
  it('Meta: accepts the exact body signed with the app secret, rejects anything else', () => {
    const raw = '{"object":"page","entry":[]}';
    const sig = meta(raw, 'app-secret-1');
    expect(verifyMetaSignature(Buffer.from(raw), sig, 'app-secret-1')).toBe(true);
    expect(verifyMetaSignature(Buffer.from(raw + ' '), sig, 'app-secret-1')).toBe(false); // body tampered
    expect(verifyMetaSignature(Buffer.from(raw), sig, 'other-secret')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(raw), undefined, 'app-secret-1')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(raw), 'sha1=abcd', 'app-secret-1')).toBe(false);
    expect(verifyMetaSignature(Buffer.from(raw), 'sha256=' + 'a'.repeat(10), 'app-secret-1')).toBe(false); // wrong length is not an exception
  });

  it('generic: signed timestamp, replay window and tamper detection', () => {
    const raw = '{"name":"A"}';
    const now = 1_800_000_000_000;
    const header = signGeneric(raw, 's3cret', now / 1000);
    expect(verifyGenericSignature(Buffer.from(raw), header, 's3cret', now)).toBe(true);
    expect(verifyGenericSignature(Buffer.from(raw), header, 's3cret', now + 299_000)).toBe(true);
    expect(verifyGenericSignature(Buffer.from(raw), header, 's3cret', now + 301_000)).toBe(false); // replay after the window
    expect(verifyGenericSignature(Buffer.from('{"name":"B"}'), header, 's3cret', now)).toBe(false);
    expect(verifyGenericSignature(Buffer.from(raw), header, 'nope', now)).toBe(false);
    expect(verifyGenericSignature(Buffer.from(raw), 't=abc,v1=00', 's3cret', now)).toBe(false);
    expect(verifyGenericSignature(Buffer.from(raw), undefined, 's3cret', now)).toBe(false);
  });

  it('Google: the key must match exactly', () => {
    expect(verifyGoogleKey({ google_key: 'k1' }, 'k1')).toBe(true);
    expect(verifyGoogleKey({ google_key: 'k2' }, 'k1')).toBe(false);
    expect(verifyGoogleKey({}, 'k1')).toBe(false);
    expect(verifyGoogleKey({ google_key: ['k1'] as unknown as string }, 'k1')).toBe(false);
  });
});

describe('parseBody', () => {
  it('reads JSON and urlencoded forms; rejects empty, malformed and non-object JSON', () => {
    expect(parseBody(Buffer.from('{"a":1}'), 'application/json; charset=utf-8')).toEqual({ a: 1 });
    expect(parseBody(Buffer.from('name=Asha&email=a%40b.co'), 'application/x-www-form-urlencoded')).toEqual({ name: 'Asha', email: 'a@b.co' });
    expect(() => parseBody(Buffer.from(''), 'application/json')).toThrow(BadPayload);
    expect(() => parseBody(Buffer.from('{oops'), 'application/json')).toThrow(BadPayload);
    expect(() => parseBody(Buffer.from('[1,2]'), 'application/json')).toThrow(BadPayload);
  });
});

describe('extractEvents', () => {
  it('Meta: one event per leadgen change, ignores other fields, empty is fine', () => {
    const body = { object: 'page', entry: [{ id: 'P1', changes: [{ field: 'leadgen', value: { leadgen_id: '111', form_id: 'F' } }, { field: 'feed', value: {} }, { field: 'leadgen', value: { leadgen_id: '222' } }] }] };
    const ev = extractEvents('meta', body, Buffer.from('x'), {});
    expect(ev.map((e) => e.eventId)).toEqual(['111', '222']);
    expect(extractEvents('meta', { object: 'page', entry: [{ id: 'P', changes: [{ field: 'feed', value: {} }] }] }, Buffer.from('x'), {})).toEqual([]);
    expect(() => extractEvents('meta', { object: 'user' }, Buffer.from('x'), {})).toThrow(BadPayload);
  });

  it('Google: event id is lead_id and the shared key is never stored', () => {
    const [e] = extractEvents('google', { lead_id: 'L-9', google_key: 'secret', is_test: true, user_column_data: [] }, Buffer.from('x'), {});
    expect(e.eventId).toBe('L-9');
    expect(e.isTest).toBe(true);
    expect(JSON.stringify(e.payload)).not.toContain('secret');
    expect(() => extractEvents('google', { google_key: 'k' }, Buffer.from('x'), {})).toThrow(BadPayload);
  });

  it('generic: header id wins, then body id, then a hash of the bytes (so an exact redelivery is deduplicated)', () => {
    expect(extractEvents('generic', { id: 'b1' }, Buffer.from('x'), { 'x-event-id': 'h1' })[0].eventId).toBe('h1');
    expect(extractEvents('generic', { id: 'b1' }, Buffer.from('x'), {})[0].eventId).toBe('b1');
    const a = extractEvents('generic', { n: 1 }, Buffer.from('{"n":1}'), {})[0].eventId;
    const b = extractEvents('generic', { n: 1 }, Buffer.from('{"n":1}'), {})[0].eventId;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('website: honeypot fields are detected and never stored', () => {
    expect(honeypotTripped({ name: 'x', _hp: 'http://spam' })).toBe(true);
    expect(honeypotTripped({ name: 'x', website_url: 'http://spam' })).toBe(true);
    expect(honeypotTripped({ name: 'x', _hp: '' })).toBe(false);
    const [e] = extractEvents('website', { name: 'Asha', _hp: '' }, Buffer.from('x'), {});
    expect(e.payload).toEqual({ name: 'Asha' });
  });
});

describe('parseMoney', () => {
  it.each([
    ['85 lakh', 8_500_000], ['1.2 cr', 12_000_000], ['50,00,000', 5_000_000], ['₹ 75L', 7_500_000], ['2 crore', 20_000_000], ['500k', 500_000], ['Rs. 90 lacs', 9_000_000],
  ])('%s → %d', (t, v) => expect(parseMoney(t)).toBe(v));
  it.each(['', 'negotiable', '50-75 lakh', '1e9999', '0'])('%j is not guessed', (t) => expect(parseMoney(t)).toBeNull());
});

describe('normalizeLead', () => {
  const cfg = {};
  it('Meta: names, contact, budget, bedrooms, locations, ids and leftover answers', () => {
    const lead = normalizeLead('meta', {
      leadgen: { leadgen_id: '555', page_id: 'P', form_id: 'F' },
      lead: {
        campaign_name: 'Diwali Launch', campaign_id: 'C1', adset_name: 'Whitefield 30-45', ad_id: 'A1', platform: 'ig',
        field_data: [
          { name: 'full_name', values: ['Asha Verma'] }, { name: 'email', values: ['ASHA@Example.com'] }, { name: 'phone_number', values: ['+91 98765 43210'] },
          { name: 'budget', values: ['85 lakh'] }, { name: 'bhk', values: ['3 BHK'] }, { name: 'preferred_location', values: ['Whitefield'] }, { name: 'when_do_you_plan_to_buy', values: ['Within 3 months'] },
        ],
      },
    }, cfg, false, 'EP');
    expect(lead).toMatchObject({ firstName: 'Asha', lastName: 'Verma', email: 'asha@example.com', phone: '+91 98765 43210', source: 'meta_ads', campaign: 'Diwali Launch', budgetMax: 8_500_000, bedroomsMin: 3, locations: ['Whitefield'], tags: [] });
    expect(lead.answers).toEqual([{ label: 'When do you plan to buy', value: 'Within 3 months' }]);
    expect(lead.details).toMatchObject({ provider: 'meta', endpointId: 'EP', leadgenId: '555', formId: 'F', campaignId: 'C1', adId: 'A1', platform: 'ig' });
  });

  it('Meta without lead details is a payload problem, not a crash', () => {
    expect(() => normalizeLead('meta', { leadgen: { leadgen_id: '1' } }, cfg, false, 'EP')).toThrow(BadPayload);
  });

  it('Google: column ids, click id, test tag', () => {
    const lead = normalizeLead('google', {
      lead_id: 'G1', campaign_id: '77', gcl_id: 'abc123', form_id: 'F9',
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Ravi Kumar' }, { column_id: 'EMAIL', string_value: 'ravi@example.com' }, { column_id: 'PHONE_NUMBER', string_value: '9876501234' }, { column_id: 'CITY', string_value: 'Pune' }],
    }, cfg, true, 'EP');
    expect(lead).toMatchObject({ firstName: 'Ravi', lastName: 'Kumar', email: 'ravi@example.com', source: 'google_ads', campaign: 'Google campaign 77', locations: ['Pune'], tags: ['test'] });
    expect(lead.details).toMatchObject({ gclid: 'abc123', formId: 'F9', leadId: 'G1' });
  });

  it('website and generic: configured source/campaign/tags, field map, tracking params kept apart', () => {
    const w = normalizeLead('website', { name: 'Meera Nair', email: 'meera@x.co', message: 'Call after 6', utm_source: 'g', utm_campaign: 'brand', gclid: 'zz' }, { source: 'portal', tags: ['Hot'] }, false, 'EP');
    expect(w).toMatchObject({ source: 'portal', campaign: 'brand', tags: ['Hot'] });
    expect(w.answers).toEqual([]);
    expect(w.message).toBe('Call after 6'); // the message box is kept whole as the visitor's own words, not as an "answer"
    expect(w.details).toMatchObject({ tracking: { utm_source: 'g', utm_campaign: 'brand', gclid: 'zz' } });
    const g = normalizeLead('generic', { id: 'x1', mobile_no: '9876501234', person: 'Kiran Rao' }, { fieldMap: { mobile_no: 'phone', person: 'name' } }, false, 'EP');
    expect(g).toMatchObject({ firstName: 'Kiran', lastName: 'Rao', phone: '9876501234', source: 'other' });
  });

  it('is defensive: control characters, huge strings, junk emails and phones never reach the lead', () => {
    const lead = normalizeLead('website', { name: 'A\u0000sha\n  Verma', email: 'not-an-email', phone: '12', note: 'x'.repeat(5000) }, cfg, false, 'EP');
    expect(lead.firstName).toBe('Asha');
    expect(lead.email).toBeNull();
    expect(lead.phone).toBeNull();
    expect(lead.message!.length).toBe(2000); // the visitor's message is kept (capped), not dropped
    expect(lead.answers.every((a) => a.value.length <= 500)).toBe(true);
    expect(lead.answers.map((a) => a.label)).toEqual(expect.arrayContaining(['Email (as entered)', 'Phone (as entered)']));
  });

  it('falls back to the email local-part or phone when no name is given', () => {
    expect(normalizeLead('website', { email: 'sam.k@x.co' }, cfg, false, 'EP').firstName).toBe('sam.k');
    expect(normalizeLead('website', { phone: '+91 98765 43210' }, cfg, false, 'EP').firstName).toBe('+91 98765 43210');
  });
});
