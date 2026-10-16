/** What an outgoing webhook can listen to, and the few constants the sender and the service share. */
export const OUTBOUND_EVENTS = {
  'lead.created': 'A new lead arrives (from any source)',
  'lead.assigned': 'A lead is given to someone',
  'lead.stage_changed': 'A lead moves to another stage (including won and lost)',
  'lead.updated': 'A lead’s details change',
  'lead.deleted': 'A lead is archived',
  'activity.created': 'A call, message, visit or note is logged',
  'task.created': 'A task is created',
  'task.completed': 'A task is done',
  'contact.created': 'A contact is added',
} as const;
export type OutboundEvent = keyof typeof OUTBOUND_EVENTS;
export const OUTBOUND_EVENT_KEYS = Object.keys(OUTBOUND_EVENTS) as [OutboundEvent, ...OutboundEvent[]];
export const isOutboundEvent = (t: string): t is OutboundEvent => t in OUTBOUND_EVENTS;

/** A message is retried for about a day; an address that keeps failing is switched off rather than hammered forever. */
export const DISABLE_AFTER_FAILURES = 30;
/** Per-message delivery attempts (with exponential back-off between them). */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** Binds an encrypted signing secret to its endpoint, so a value copied to another row fails to decrypt. */
export const secretAad = (endpointId: string) => `outbound:${endpointId}`;
