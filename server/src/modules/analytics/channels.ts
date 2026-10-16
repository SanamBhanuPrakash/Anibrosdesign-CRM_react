/**
 * Sources and channels, in plain words.
 *  - Source: where one enquiry came from (Meta ads, Google ads, website, referral …). A fixed list (`lead_source`).
 *  - Channel: the KIND of marketing a source belongs to. A workspace may re-map a source to another channel; the default table is below.
 * "Not recorded" (`other`) means nobody recorded a source. It is reported as untracked, never as a marketing channel.
 */
export const LEAD_SOURCE_KEYS = ['website', 'referral', 'portal', 'direct', 'meta_ads', 'google_ads', 'walk_in', 'other'] as const;
export type SourceKey = (typeof LEAD_SOURCE_KEYS)[number];

export const SOURCE_LABEL: Record<SourceKey, string> = {
  website: 'Website',
  referral: 'Referral',
  portal: 'Property portal',
  direct: 'Direct',
  meta_ads: 'Meta ads',
  google_ads: 'Google ads',
  walk_in: 'Walk-in',
  other: 'Not recorded',
};

export const CHANNELS = [
  { key: 'paid_social', label: 'Paid social' },
  { key: 'paid_search', label: 'Paid search' },
  { key: 'website', label: 'Website' },
  { key: 'referral', label: 'Referral' },
  { key: 'portal', label: 'Property portals' },
  { key: 'offline', label: 'Offline' },
  { key: 'direct', label: 'Direct' },
  { key: 'untracked', label: 'Not recorded' },
] as const;
export type ChannelKey = (typeof CHANNELS)[number]['key'];
export const CHANNEL_KEYS = CHANNELS.map((c) => c.key) as [ChannelKey, ...ChannelKey[]];
export const channelLabel = (k: string): string => CHANNELS.find((c) => c.key === k)?.label ?? k;

export const DEFAULT_CHANNEL: Record<SourceKey, ChannelKey> = {
  meta_ads: 'paid_social',
  google_ads: 'paid_search',
  website: 'website',
  referral: 'referral',
  portal: 'portal',
  walk_in: 'offline',
  direct: 'direct',
  other: 'untracked',
};

export const sourceLabel = (k: string): string => SOURCE_LABEL[k as SourceKey] ?? k;
