import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function logEvent(
  tenantId: string | null,
  severity: "debug" | "info" | "warn" | "error",
  eventName: string,
  message: string,
  correlationId: string,
  context: Record<string, unknown> = {},
) {
  try {
    await supabase.from("operational_logs").insert({
      tenant_id: tenantId,
      severity,
      component: "webhook",
      event_name: eventName,
      message,
      correlation_id: correlationId,
      context: { ...context, source: "webhook-ingestion" },
    });
  } catch { /* logging must never break the request */ }
}

async function hmacSha256(key: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const messageData = encoder.encode(data);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageData);
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  const url = new URL(req.url);
  const path = url.pathname;
  const correlationId = crypto.randomUUID();

  try {
    if (path.includes("/google-lead")) return await handleGoogleLead(req, correlationId);
    if (path.includes("/meta-lead")) {
      if (req.method === "GET") return await handleMetaVerification(req, url);
      return await handleMetaLead(req, correlationId);
    }
    return new Response(JSON.stringify({ error: "Unknown webhook endpoint" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Webhook error:", err);
    await logEvent(null, "error", "webhook.handler_error", err instanceof Error ? err.message : "Unknown error", correlationId, { path });
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function handleMetaVerification(_req: Request, url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = url.searchParams.get("hub.verify_token");
  const expectedToken = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN");

  if (!expectedToken) {
    console.error("META_WEBHOOK_VERIFY_TOKEN not configured on server");
    return new Response(JSON.stringify({ error: "Server webhook verification not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (mode === "subscribe" && challenge && verifyToken) {
    if (!safeEqual(verifyToken, expectedToken)) {
      return new Response(JSON.stringify({ error: "Invalid verify token" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(challenge, { status: 200, headers: { ...corsHeaders, "Content-Type": "text/plain" } });
  }
  return new Response(JSON.stringify({ error: "Invalid verification request" }), {
    status: 400,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleGoogleLead(req: Request, correlationId: string): Promise<Response> {
  try {
    const body = await req.json();
    const leadId = body.lead_id;
    const googleKey = body.google_key;
    const integrationId = body.integration_id;

    if (!leadId || !googleKey || !integrationId) {
      await logEvent(null, "warn", "webhook.google.missing_fields", "Missing lead_id, google_key, or integration_id", correlationId);
      return new Response(JSON.stringify({ error: "Missing required fields: lead_id, google_key, integration_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: integration, error: intError } = await supabase
      .from("integrations").select("id, tenant_id, config, status").eq("id", integrationId).eq("provider", "google_ads").maybeSingle();

    if (intError || !integration) {
      await logEvent(null, "warn", "webhook.google.invalid_integration", `Integration lookup failed for ${integrationId}`, correlationId);
      return new Response(JSON.stringify({ error: "Invalid integration" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (integration.status !== "active") {
      await logEvent(integration.tenant_id, "warn", "webhook.google.inactive", `Integration ${integrationId} is not active`, correlationId);
      return new Response(JSON.stringify({ error: "Integration is not active" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const expectedKey = integration.config?.google_key;
    if (!expectedKey || !safeEqual(String(googleKey), String(expectedKey))) {
      await logEvent(integration.tenant_id, "error", "webhook.google.key_mismatch", "Webhook key verification failed", correlationId, { integration_id: integrationId });
      return new Response(JSON.stringify({ error: "Invalid webhook key" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const isTest = body.is_test === true || body.user_column_data?.some(
      (col: { column_id?: string; string_value?: string }) => col.column_id === "Is Test" && col.string_value === "true",
    );

    const { error: insertError } = await supabase.from("webhook_inbox").insert({
      integration_id: integration.id, tenant_id: integration.tenant_id,
      provider: "google_ads", provider_event_id: String(leadId),
      raw_payload: { ...body, _correlation_id: correlationId },
      status: "received", is_test: isTest,
    });

    if (insertError) {
      if (insertError.code === "23505") {
        await logEvent(integration.tenant_id, "info", "webhook.google.duplicate", `Duplicate event ${leadId} ignored`, correlationId);
        return new Response(JSON.stringify({ status: "duplicate", message: "Event already received" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await logEvent(integration.tenant_id, "error", "webhook.google.persist_failed", insertError.message, correlationId);
      return new Response(JSON.stringify({ error: "Failed to persist event" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    await logEvent(integration.tenant_id, "info", "webhook.google.received", `Lead ${leadId} received from Google Ads`, correlationId, { provider_event_id: String(leadId), is_test: isTest });
    return new Response(JSON.stringify({ status: "received", correlation_id: correlationId }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Google lead handler error:", err);
    await logEvent(null, "error", "webhook.google.handler_error", err instanceof Error ? err.message : "Unknown error", correlationId);
    return new Response(JSON.stringify({ error: "Failed to process webhook" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

async function handleMetaLead(req: Request, correlationId: string): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const appSecret = Deno.env.get("META_APP_SECRET");

  if (!appSecret) {
    await logEvent(null, "error", "webhook.meta.no_secret", "META_APP_SECRET not configured on server", correlationId);
    return new Response(JSON.stringify({ error: "Server webhook secret not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!signature) {
    await logEvent(null, "warn", "webhook.meta.missing_signature", "Missing x-hub-signature-256 header", correlationId);
    return new Response(JSON.stringify({ error: "Missing signature header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const expectedSig = "sha256=" + await hmacSha256(appSecret, rawBody);
  if (!safeEqual(signature, expectedSig)) {
    await logEvent(null, "error", "webhook.meta.signature_failed", "Meta webhook signature verification failed", correlationId);
    return new Response(JSON.stringify({ error: "Signature verification failed" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    await logEvent(null, "warn", "webhook.meta.invalid_json", "Invalid JSON in Meta webhook body", correlationId);
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (body.object === "page" && Array.isArray(body.entry)) {
    let processedCount = 0;
    for (const entry of body.entry) {
      for (const change of (entry.changes ?? [])) {
        if (change.field === "leadgen") {
          const leadgenId = change.value?.leadgen_id;
          const pageId = entry.id;
          if (!leadgenId) continue;

          const { data: integration } = await supabase
            .from("integrations").select("id, tenant_id, config, status")
            .eq("provider", "meta_lead_ads").eq("config->>page_id", pageId).maybeSingle();

          if (!integration) {
            await logEvent(null, "warn", "webhook.meta.no_integration", `No integration found for page ${pageId}`, correlationId, { page_id: pageId });
            continue;
          }
          if (integration.status !== "active") {
            await logEvent(integration.tenant_id, "warn", "webhook.meta.inactive", `Integration for page ${pageId} is not active`, correlationId);
            continue;
          }

          const { error: insertError } = await supabase.from("webhook_inbox").insert({
            integration_id: integration.id, tenant_id: integration.tenant_id,
            provider: "meta_lead_ads", provider_event_id: String(leadgenId),
            raw_payload: { ...change.value, _correlation_id: correlationId },
            status: "received", is_test: false,
          });

          if (insertError) {
            if (insertError.code === "23505") {
              await logEvent(integration.tenant_id, "info", "webhook.meta.duplicate", `Duplicate event ${leadgenId} ignored`, correlationId);
              continue;
            }
            await logEvent(integration.tenant_id, "error", "webhook.meta.persist_failed", insertError.message, correlationId);
            continue;
          }
          processedCount++;
          await logEvent(integration.tenant_id, "info", "webhook.meta.received", `Lead ${leadgenId} received from Meta`, correlationId, { provider_event_id: String(leadgenId) });
        }
      }
    }
    return new Response(JSON.stringify({ status: "received", correlation_id: correlationId, processed: processedCount }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  await logEvent(null, "warn", "webhook.meta.unrecognized_format", "Unrecognized Meta webhook format", correlationId);
  return new Response(JSON.stringify({ error: "Unrecognized Meta webhook format" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
