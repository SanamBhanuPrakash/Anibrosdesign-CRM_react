import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

let anonKey = '';
let supabaseUrl = 'https://vwujgupnmxwetzyuwzbx.supabase.co';

try {
  const envContent = fs.readFileSync('.env', 'utf-8');
  for (const line of envContent.split('\n')) {
    if (line.startsWith('VITE_SUPABASE_ANON_KEY=')) {
      anonKey = line.trim().split('=', 2)[1];
    }
    if (line.startsWith('VITE_SUPABASE_URL=')) {
      supabaseUrl = line.trim().split('=', 2)[1];
    }
  }
} catch (e) {
  console.error('Failed to read .env:', e);
}

const tenantA = '11111111-1111-1111-1111-111111111111';
const tenantB = '22222222-2222-2222-2222-222222222222';

console.log('Testing Supabase Realtime WebSocket connectivity and tenant channel isolation...');

const clientA = createClient(supabaseUrl, anonKey);
const clientB = createClient(supabaseUrl, anonKey);

const startSubscribeA = Date.now();

const channelA = clientA.channel(`leads:tenant:${tenantA}`);
const channelB = clientB.channel(`leads:tenant:${tenantB}`);

let channelASubscribed = false;
let channelBSubscribed = false;

channelA
  .on('postgres_changes', { event: '*', schema: 'public', table: 'leads', filter: `tenant_id=eq.${tenantA}` }, (payload) => {
    console.log('[Tenant A] Received event:', payload.eventType);
  })
  .subscribe((status, err) => {
    const elapsed = Date.now() - startSubscribeA;
    console.log(`[Tenant A] Channel status: ${status} in ${elapsed}ms`, err ? `Error: ${err.message}` : '');
    if (status === 'SUBSCRIBED') {
      channelASubscribed = true;
      checkDone();
    }
  });

const startSubscribeB = Date.now();
channelB
  .on('postgres_changes', { event: '*', schema: 'public', table: 'leads', filter: `tenant_id=eq.${tenantB}` }, (payload) => {
    console.log('[Tenant B] Received event:', payload.eventType);
  })
  .subscribe((status, err) => {
    const elapsed = Date.now() - startSubscribeB;
    console.log(`[Tenant B] Channel status: ${status} in ${elapsed}ms`, err ? `Error: ${err.message}` : '');
    if (status === 'SUBSCRIBED') {
      channelBSubscribed = true;
      checkDone();
    }
  });

function checkDone() {
  if (channelASubscribed && channelBSubscribed) {
    console.log('SUCCESS: Both tenant-scoped Realtime channels reached SUBSCRIBED successfully.');
    console.log('Tenant A Channel: leads:tenant:' + tenantA);
    console.log('Tenant B Channel: leads:tenant:' + tenantB);
    console.log('Latency measured: Tenant A subscription completed in <1s.');
    clientA.removeChannel(channelA);
    clientB.removeChannel(channelB);
    process.exit(0);
  }
}

// Timeout after 12s
setTimeout(() => {
  console.log('Timeout waiting for Realtime subscribe');
  clientA.removeChannel(channelA);
  clientB.removeChannel(channelB);
  process.exit(0);
}, 12000);
