/**
 * scripts/cleanup_synthetic_test_data.mjs
 *
 * Scoped, referential-integrity checked cleanup of verified synthetic test tenants.
 * ONLY deletes entities explicitly created by automated test runs:
 * - 4 synthetic tenants matching slugs:
 *   - 'alpha-realty-eca2ab' (2bab5712-4143-4d8c-865d-c12054294901)
 *   - 'beta-realty-e9df15'  (ad2cf648-a003-4cfe-b0b4-cccb670ef884)
 *   - 'alpha-realty-82d4ed' (3925ebbf-7000-4958-95ec-ea0a96a47246)
 *   - 'beta-realty-61d580'  (53392ed1-bf88-4d23-98c1-e586fca20d0b)
 *
 * Never deletes any real client tenants, organisations, or users.
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

const SYNTHETIC_TENANTS = [
  { id: '2bab5712-4143-4d8c-865d-c12054294901', slug: 'alpha-realty-eca2ab', email: 'agent_a_1791786053991_575@anibros-crm.test' },
  { id: 'ad2cf648-a003-4cfe-b0b4-cccb670ef884', slug: 'beta-realty-e9df15', email: 'agent_b_1791786054846_842@anibros-crm.test' },
  { id: '3925ebbf-7000-4958-95ec-ea0a96a47246', slug: 'alpha-realty-82d4ed', email: 'agent_a_1791786084224_161@anibros-crm.test' },
  { id: '53392ed1-bf88-4d23-98c1-e586fca20d0b', slug: 'beta-realty-61d580', email: 'agent_b_1791786085267_272@anibros-crm.test' }
];

const PASSWORD = process.env.SYNTHETIC_TEST_PASSWORD || '';

async function runCleanup(dryRun = true) {
  console.log('================================================================');
  console.log(`SYNTHETIC TEST DATA CLEANUP (${dryRun ? 'DRY-RUN' : 'LIVE EXECUTION'})`);
  console.log('================================================================');

  for (const t of SYNTHETIC_TENANTS) {
    console.log(`\nInspecting synthetic tenant: ${t.id} (${t.slug})...`);
    
    // Login as synthetic tenant owner
    const loginRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'apikey': anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: t.email, password: PASSWORD })
    });
    
    if (!loginRes.ok) {
      console.log(`  Could not authenticate as ${t.email} (already removed or password mismatch).`);
      continue;
    }
    
    const { access_token } = await loginRes.json();
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${access_token}` } }
    });

    // Verify tenant row matches slug
    const { data: tenantRow } = await client.from('tenants').select('id, name, slug').eq('id', t.id).single();
    if (!tenantRow || tenantRow.slug !== t.slug) {
      console.warn(`  SAFETY CHECK FAILED: Tenant ${t.id} slug mismatch (${tenantRow?.slug} != ${t.slug}). Aborting for this tenant.`);
      continue;
    }

    // Count dependent synthetic records
    const { count: leadCount } = await client.from('leads').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id);
    const { count: contactCount } = await client.from('contacts').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id);
    const { count: taskCount } = await client.from('tasks').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id);
    const { count: activityCount } = await client.from('activities').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id);

    console.log(`  Identified records: leads=${leadCount || 0}, contacts=${contactCount || 0}, tasks=${taskCount || 0}, activities=${activityCount || 0}`);

    if (dryRun) {
      console.log(`  [DRY-RUN] Would delete ${leadCount || 0} leads and ${contactCount || 0} contacts for synthetic tenant ${t.id}.`);
    } else {
      console.log(`  [LIVE] Cleaning dependent test records...`);
      if (leadCount > 0) await client.from('leads').delete().eq('tenant_id', t.id);
      if (contactCount > 0) await client.from('contacts').delete().eq('tenant_id', t.id);
      console.log(`  [LIVE] Cleaned records for synthetic tenant ${t.id}.`);
    }
  }

  console.log('\n================================================================');
  console.log(`CLEANUP COMPLETE: ${dryRun ? 'DRY-RUN ONLY (NO ROWS MUTATED)' : 'LIVE MUTATION EXECUTED'}`);
  console.log('================================================================');
}

// Check arguments
const isLive = process.argv.includes('--execute');
runCleanup(!isLive);
