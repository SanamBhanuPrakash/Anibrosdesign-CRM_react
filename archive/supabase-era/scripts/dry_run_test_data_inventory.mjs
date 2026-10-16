/**
 * scripts/dry_run_test_data_inventory.mjs
 *
 * Scans and inventories all synthetic test entities created during test runs:
 * - Test auth users (matching *@anibros-crm.test)
 * - Associated tenant & organisation records
 * - Tenant memberships
 * - Synthetic contacts and leads
 * - Webhook inbox and outbox records
 * - Operational logs and audit logs
 *
 * Produces a strict dry-run inventory without deleting anything.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

let anonKey = '';
let supabaseUrl = 'https://vwujgupnmxwetzyuwzbx.supabase.co';

try {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split('\n')) {
    if (line.startsWith('VITE_SUPABASE_ANON_KEY=')) anonKey = line.trim().split('=', 2)[1];
    if (line.startsWith('VITE_SUPABASE_URL=')) supabaseUrl = line.trim().split('=', 2)[1];
  }
} catch (e) {
  console.error('Failed to read .env:', e);
  process.exit(1);
}

const PASSWORD = process.env.SYNTHETIC_TEST_PASSWORD || '';

// Extract test emails from transcript and test scripts
const knownTestEmails = [
  'agent_a_1791786053991_575@anibros-crm.test',
  'agent_b_1791786054846_842@anibros-crm.test',
  'agent_a_1791786084224_161@anibros-crm.test',
  'agent_b_1791786085267_272@anibros-crm.test',
];

// Also scan transcript.jsonl for all emails matching *.test
try {
  const tContent = fs.readFileSync('C:/Users/Sanam/.gemini/antigravity-ide/brain/a8244f0e-4128-4a53-bfbb-f759674d7538/.system_generated/logs/transcript.jsonl', 'utf-8');
  const matches = tContent.match(/[a-zA-Z0-9_]+@[a-zA-Z0-9_\-\.]+\.test/g);
  if (matches) {
    matches.forEach(m => {
      if (m.endsWith('@anibros-crm.test') && !knownTestEmails.includes(m)) {
        knownTestEmails.push(m);
      }
    });
  }
} catch (e) {
  console.warn('Could not read transcript:', e.message);
}

console.log('Discovered', knownTestEmails.length, 'candidate test emails to inventory.');

async function inventory() {
  const inventoryReport = {
    authUsers: [],
    tenants: new Map(),
    organisations: new Map(),
    memberships: [],
    contacts: [],
    leads: [],
    activities: [],
    viewings: [],
    auditLogs: [],
    webhookInbox: [],
    outboxEvents: [],
    integrations: []
  };

  for (const email of knownTestEmails) {
    try {
      const loginRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { 'apikey': anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD })
      });
      if (!loginRes.ok) continue;

      const authData = await loginRes.json();
      const token = authData.access_token;
      const user = authData.user;
      inventoryReport.authUsers.push({ id: user.id, email: user.email, created_at: user.created_at });

      const client = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } }
      });

      // Get memberships
      const { data: mems } = await client.from('tenant_memberships').select('*');
      for (const m of (mems || [])) {
        inventoryReport.memberships.push(m);

        // Get tenant details
        if (!inventoryReport.tenants.has(m.tenant_id)) {
          const { data: tenant } = await client.from('tenants').select('*').eq('id', m.tenant_id).maybeSingle();
          if (tenant) inventoryReport.tenants.set(m.tenant_id, tenant);
        }

        // Get contacts
        const { data: contacts } = await client.from('contacts').select('*').eq('tenant_id', m.tenant_id);
        (contacts || []).forEach(c => inventoryReport.contacts.push(c));

        // Get leads
        const { data: leads } = await client.from('leads').select('*').eq('tenant_id', m.tenant_id);
        (leads || []).forEach(l => inventoryReport.leads.push(l));

        // Get activities
        const { data: acts } = await client.from('activities').select('*').eq('tenant_id', m.tenant_id);
        (acts || []).forEach(a => inventoryReport.activities.push(a));

        // Get viewings
        const { data: viewings } = await client.from('viewings').select('*').eq('tenant_id', m.tenant_id);
        (viewings || []).forEach(v => inventoryReport.viewings.push(v));

        // Get integrations
        const { data: integs } = await client.from('integrations').select('*').eq('tenant_id', m.tenant_id);
        (integs || []).forEach(it => inventoryReport.integrations.push(it));

        // Get webhook inbox
        const { data: inbox } = await client.from('webhook_inbox').select('id, integration_id, provider_event_id, status, created_at').eq('tenant_id', m.tenant_id);
        (inbox || []).forEach(ib => inventoryReport.webhookInbox.push(ib));

        // Get outbox events
        const { data: outbox } = await client.from('outbox_events').select('id, integration_id, event_type, status, created_at').eq('tenant_id', m.tenant_id);
        (outbox || []).forEach(ob => inventoryReport.outboxEvents.push(ob));

        // Get audit logs
        const { data: audits } = await client.from('audit_logs').select('id, action, entity_type, entity_id, created_at').eq('tenant_id', m.tenant_id);
        (audits || []).forEach(al => inventoryReport.auditLogs.push(al));
      }
    } catch (err) {
      console.warn(`Error scanning user ${email}:`, err.message);
    }
  }

  // De-duplicate lists
  const dedupe = (arr) => Array.from(new Map(arr.map(item => [item.id, item])).values());

  const uniqueUsers = dedupe(inventoryReport.authUsers);
  const uniqueTenants = Array.from(inventoryReport.tenants.values());
  const uniqueContacts = dedupe(inventoryReport.contacts);
  const uniqueLeads = dedupe(inventoryReport.leads);
  const uniqueActs = dedupe(inventoryReport.activities);
  const uniqueViews = dedupe(inventoryReport.viewings);
  const uniqueIntegs = dedupe(inventoryReport.integrations);
  const uniqueInbox = dedupe(inventoryReport.webhookInbox);
  const uniqueOutbox = dedupe(inventoryReport.outboxEvents);
  const uniqueAudits = dedupe(inventoryReport.auditLogs);

  console.log('\n================================================================');
  console.log('DRY-RUN SYNTHETIC TEST DATA INVENTORY (NO DELETIONS PERFORMED)');
  console.log('================================================================');
  console.log(`Synthetic Auth Users:       ${uniqueUsers.length}`);
  uniqueUsers.forEach(u => console.log(`  - User ID: ${u.id} | Email: ${u.email} | Created: ${u.created_at}`));

  console.log(`\nSynthetic Tenants Created:   ${uniqueTenants.length}`);
  uniqueTenants.forEach(t => console.log(`  - Tenant ID: ${t.id} | Name: "${t.name}" | Slug: "${t.slug}"`));

  console.log(`\nSynthetic Memberships:       ${inventoryReport.memberships.length}`);
  console.log(`Synthetic Contacts:          ${uniqueContacts.length}`);
  console.log(`Synthetic Leads:             ${uniqueLeads.length}`);
  console.log(`Synthetic Activities:        ${uniqueActs.length}`);
  console.log(`Synthetic Viewings:          ${uniqueViews.length}`);
  console.log(`Synthetic Integrations:      ${uniqueIntegs.length}`);
  console.log(`Synthetic Webhook Inbox:     ${uniqueInbox.length}`);
  console.log(`Synthetic Outbox Events:     ${uniqueOutbox.length}`);
  console.log(`Synthetic Audit Logs:        ${uniqueAudits.length}`);

  console.log('\n--- IDENTIFIED SYNTHETIC TEST TENANTS FOR REVIEW ---');
  uniqueTenants.forEach(t => {
    const isTest = t.name.includes('Alpha') || t.name.includes('Beta') || t.name.includes('Test') || t.name.includes('Viewing') || t.name.includes('Webhook');
    console.log(`  Tenant: ${t.id} ("${t.name}") -> Classification: ${isTest ? 'SYNTHETIC TEST TENANT' : 'UNKNOWN / PRESERVE'}`);
  });

  console.log('\n================================================================');
  console.log('END OF DRY-RUN INVENTORY — NO DELETIONS EXECUTED');
  console.log('================================================================\n');
}

inventory().catch(err => {
  console.error('Inventory error:', err);
  process.exit(1);
});
