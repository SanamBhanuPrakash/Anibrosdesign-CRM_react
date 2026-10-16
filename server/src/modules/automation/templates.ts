/**
 * Automation templates. A template is CODE: a fixed trigger, a fixed list of steps and the workspace settings it reads.
 * A workspace turns a template on or off; it cannot change what the steps do (no free-form actions, no URLs, no scripts),
 * which is what keeps an automation predictable, reviewable and safe to run unattended.
 *
 * Only steps that are real today exist here. E-mail and WhatsApp steps will be added with their provider integrations,
 * not before (decision D9).
 */
export const TEMPLATE_KEYS = ['new_lead_follow_up'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface TemplateStep {
  id: 'owner' | 'task' | 'notify';
  label: string;
}

export interface TemplateDefinition {
  key: TemplateKey;
  name: string;
  summary: string;
  /** Matches the `automation_trigger` database enum. */
  trigger: 'lead_created';
  triggerLabel: string;
  steps: TemplateStep[];
  /** Workspace settings the steps read (shown to the user so nothing is hidden). */
  usesSettings: Array<'leadAssignment' | 'firstResponseMinutes'>;
}

export const TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  new_lead_follow_up: {
    key: 'new_lead_follow_up',
    name: 'Follow up every new lead',
    summary: 'Makes sure every new lead has an owner, a call task and a nudge, so none waits unnoticed.',
    trigger: 'lead_created',
    triggerLabel: 'A lead is created: by hand, by import or by a lead source (Meta, Google, website)',
    steps: [
      { id: 'owner', label: 'Keep the owner if one was chosen. Otherwise give the lead to a salesperson using your assignment rule.' },
      { id: 'task', label: 'Create one call task for the owner, due within your first-reply time.' },
      { id: 'notify', label: 'Notify the owner. Nobody is notified about a lead they created for themselves.' },
    ],
    usesSettings: ['leadAssignment', 'firstResponseMinutes'],
  },
};

export const isTemplateKey = (k: string): k is TemplateKey => (TEMPLATE_KEYS as readonly string[]).includes(k);
