/**
 * What kinds of work an employee may log inside a client. NULL on the membership means everything (the default); a specialist has a short list.
 * Notes are always allowed: writing down what happened is never a channel.
 */
export const WORK_CHANNELS = ['call', 'whatsapp', 'sms', 'email', 'instagram', 'meeting'] as const;
export type WorkChannel = (typeof WORK_CHANNELS)[number];

export const WORK_CHANNEL_LABEL: Record<WorkChannel, string> = {
  call: 'phone calls',
  whatsapp: 'WhatsApp',
  sms: 'text messages',
  email: 'e-mail',
  instagram: 'Instagram messages',
  meeting: 'visits and meetings',
};

/** The channel an activity type belongs to, or null for a note (always allowed). */
export const channelOf = (activityType: string): WorkChannel | null => ((WORK_CHANNELS as readonly string[]).includes(activityType) ? (activityType as WorkChannel) : null);

/** Words for an error message: "WhatsApp and phone calls". */
export const describeChannels = (channels: readonly string[]): string => {
  const names = channels.map((c) => WORK_CHANNEL_LABEL[c as WorkChannel] ?? c);
  return names.length <= 1 ? (names[0] ?? 'nothing') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};
