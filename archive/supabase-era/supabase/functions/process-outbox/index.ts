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

const MAX_RETRIES = 5;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];

async function logEvent(
  tenantId: string | null,
  severity: "debug" | "info" | "warn" | "error",
  eventName: string,
  message: string,
  correlationId: string,
  context: Record<string, unknown> = {},
  durationMs?: number,
) {
  try {
    await supabase.from("operational_logs").insert({
      tenant_id: tenantId, severity, component: "outbox",
      event_name: eventName, message, correlation_id: correlationId,
      duration_ms: durationMs ?? null,
      context: { ...context, source: "process-outbox" },
    });
  } catch { /* logging must never break processing */ }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

interface CallerAuth {
  isGlobalWorker: boolean;
  tenantId?: string;
  userId?: string;
}

async function authenticateCaller(req: Request, bodyTenantId?: string): Promise<{ authorized: boolean; auth?: CallerAuth; error?: string; status?: number }> {
  const authHeader = req.headers.get("Authorization");
  const workerSecret = req.headers.get("x-worker-secret");
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // Mode 1: Trusted global cron / server worker via secret header
  if (cronSecret && workerSecret && safeEqual(workerSecret, cronSecret)) {
    return { authorized: true, auth: { isGlobalWorker: true } };
  }

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "").trim();

    // Mode 1b: Service-role key used by trusted internal systems
    if (serviceRoleKey && safeEqual(token, serviceRoleKey)) {
      return { authorized: true, auth: { isGlobalWorker: true } };
    }

    // Mode 2: Authenticated user / operator from frontend UI
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return { authorized: false, error: "Invalid or expired authentication token", status: 401 };
    }

    if (!bodyTenantId) {
      return { authorized: false, error: "Missing required tenant_id for operator execution", status: 400 };
    }

    // Verify user role in tenant_memberships
    const { data: membership, error: memError } = await supabase
      .from("tenant_memberships")
      .select("role")
      .eq("tenant_id", bodyTenantId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    const allowedRoles = ["tenant_owner", "tenant_admin", "sales_manager", "marketing_manager"];
    if (memError || !membership || !allowedRoles.includes(membership.role)) {
      return { authorized: false, error: "Forbidden: insufficient role to process tenant outbox", status: 403 };
    }

    return { authorized: true, auth: { isGlobalWorker: false, tenantId: bodyTenantId, userId: user.id } };
  }

  return { authorized: false, error: "Unauthorized: valid authentication token or worker secret required", status: 401 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch { /* empty body ok */ }
  }

  const reqTenantId = body.tenant_id as string | undefined;
  const authResult = await authenticateCaller(req, reqTenantId);
  if (!authResult.authorized) {
    return new Response(JSON.stringify({ error: authResult.error }), {
      status: authResult.status ?? 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const callerAuth = authResult.auth!;
  const jobCorrelationId = crypto.randomUUID();
  const startTime = Date.now();

  try {
    const now = new Date().toISOString();
    let query = supabase
      .from("outbox_events").select("*")
      .in("status", ["pending", "retrying"])
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
      .order("created_at", { ascending: true })
      .limit(10);

    // Strict tenant isolation: operator-triggered worker ONLY processes their own tenant's items
    if (!callerAuth.isGlobalWorker && callerAuth.tenantId) {
      query = query.eq("tenant_id", callerAuth.tenantId);
    }

    const { data: events, error: fetchError } = await query;

    if (fetchError) {
      console.error("Failed to fetch outbox events:", fetchError);
      await logEvent(callerAuth.tenantId ?? null, "error", "outbox.fetch_failed", fetchError.message, jobCorrelationId);
      return new Response(JSON.stringify({ error: "Failed to fetch events" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!events || events.length === 0) {
      return new Response(JSON.stringify({ processed: 0, failed: 0, total: 0, correlation_id: jobCorrelationId }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let processed = 0, failed = 0;
    for (const event of events) {
      const result = await processOutboxEvent(event, jobCorrelationId);
      if (result) processed++; else failed++;
    }

    const durationMs = Date.now() - startTime;
    await logEvent(callerAuth.tenantId ?? null, "info", "outbox.batch_complete", `Processed ${processed}, failed ${failed}`, jobCorrelationId, {
      processed,
      failed,
      total: events.length,
      duration_ms: durationMs,
      is_global_worker: callerAuth.isGlobalWorker,
      operator_user_id: callerAuth.userId ?? null,
    }, durationMs);

    return new Response(JSON.stringify({ processed, failed, total: events.length, correlation_id: jobCorrelationId }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Outbox processor error:", err);
    await logEvent(callerAuth.tenantId ?? null, "error", "outbox.processor_error", err instanceof Error ? err.message : "Unknown error", jobCorrelationId);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

function sanitizeProviderText(text: string | null | undefined): string | null {
  if (!text) return null;
  const truncated = text.substring(0, 2000);
  return truncated.replace(/(access_token|client_secret|authorization|bearer|refresh_token)\s*[:=]\s*["']?[^"'\s,]+/gi, '$1: "[REDACTED]"');
}

async function processOutboxEvent(event: Record<string, unknown>, jobCorrelationId: string): Promise<boolean> {
  const eventId = event.id as string;
  const tenantId = event.tenant_id as string;
  const eventType = event.event_type as string;
  const provider = event.provider as string;
  const integrationId = event.integration_id as string;
  const retryCount = (event.retry_count as number) ?? 0;
  const payload = event.payload as Record<string, unknown>;
  const eventCorrelationId = (payload._correlation_id as string) || jobCorrelationId;
  const eventStartTime = Date.now();

  const { data: claimed, error: claimError } = await supabase
    .from("outbox_events")
    .update({ status: "processing" })
    .eq("id", eventId)
    .in("status", ["pending", "retrying"])
    .select("id");

  if (claimError || !claimed || claimed.length === 0) {
    // Another concurrent worker claimed this event or lease expired — safely yield
    return false;
  }

  try {
    const { data: integration, error: intError } = await supabase
      .from("integrations")
      .select("id, tenant_id, provider, config, status, credential_ref")
      .eq("id", integrationId)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (intError || !integration) throw new Error(`Integration not found or does not belong to event tenant: ${integrationId}`);
    if (integration.status !== "active") throw new Error(`Integration ${integrationId} is not active (status: ${integration.status})`);

    const contactId = payload.contact_id as string | undefined;
    if (contactId) {
      const { data: consent } = await supabase
        .from("communication_consents").select("status")
        .eq("tenant_id", tenantId).eq("contact_id", contactId).eq("channel", "email").maybeSingle();
      if (consent?.status === "opted_out") {
        await supabase.from("outbox_events").update({ status: "rejected", error_detail: "Consent withdrawn — conversion event suppressed" }).eq("id", eventId);
        await logEvent(tenantId, "info", "outbox.consent_suppressed", `Event ${eventId} suppressed (consent withdrawn)`, eventCorrelationId, { event_id: eventId });
        return true;
      }
    }

    let responseStatus: number | null = null;
    let responseBody: string | null = null;

    if (provider === "meta_conversions" || eventType === "meta_conversion") {
      const result = await sendMetaConversion(integration, payload, eventCorrelationId);
      responseStatus = result.status; responseBody = result.body;
    } else if (provider === "google_enhanced_conversions" || eventType === "google_conversion") {
      const result = await sendGoogleConversion(integration, payload, eventCorrelationId);
      responseStatus = result.status; responseBody = result.body;
    } else {
      await supabase.from("outbox_events").update({ status: "rejected", error_detail: `Unknown provider/event type: ${provider}/${eventType}` }).eq("id", eventId);
      await logEvent(tenantId, "warn", "outbox.unknown_provider", `Unknown provider: ${provider}/${eventType}`, eventCorrelationId, { event_id: eventId });
      return true;
    }

    if (responseStatus !== null && responseStatus >= 200 && responseStatus < 300) {
      const sanitizedResp = sanitizeProviderText(responseBody);
      await supabase.from("outbox_events").update({
        status: "sent", sent_at: new Date().toISOString(),
        response_status: responseStatus, response_body: sanitizedResp, error_detail: null,
      }).eq("id", eventId);
      await supabase.from("integrations").update({ last_success_at: new Date().toISOString(), last_error_at: null, last_error_detail: null }).eq("id", integrationId);
      const durationMs = Date.now() - eventStartTime;
      await logEvent(tenantId, "info", "outbox.sent", `Event ${eventId} sent (${responseStatus})`, eventCorrelationId, { event_id: eventId, http_status: responseStatus, duration_ms: durationMs }, durationMs);
      return true;
    } else {
      throw new Error(`Provider returned status ${responseStatus}: ${sanitizeProviderText(responseBody)}`);
    }
  } catch (err) {
    console.error(`Outbox event ${eventId} failed:`, err);
    const newRetryCount = retryCount + 1;
    const isDead = newRetryCount >= MAX_RETRIES;
    const backoffIndex = Math.min(newRetryCount - 1, BACKOFF_SECONDS.length - 1);
    const backoffSeconds = BACKOFF_SECONDS[backoffIndex];
    const nextAttempt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    const rawErrorMsg = err instanceof Error ? err.message : "Unknown error";
    const errorMsg = sanitizeProviderText(rawErrorMsg) || "Unknown error";

    await supabase.from("outbox_events").update({
      status: isDead ? "dead_letter" : "retrying", retry_count: newRetryCount,
      next_attempt_at: isDead ? null : nextAttempt, error_detail: errorMsg,
    }).eq("id", eventId);
    await supabase.from("integrations").update({ last_error_at: new Date().toISOString(), last_error_detail: errorMsg }).eq("id", integrationId);

    await logEvent(tenantId, isDead ? "error" : "warn",
      isDead ? "outbox.dead_lettered" : "outbox.retry_scheduled",
      `Event ${eventId} ${isDead ? "dead-lettered" : `retrying in ${backoffSeconds}s`}: ${errorMsg}`,
      eventCorrelationId, { event_id: eventId, retry_count: newRetryCount, max_retries: MAX_RETRIES, integration_id: integrationId });
    return false;
  }
}

function resolveMetaAccessToken(integration: Record<string, unknown>): string | null {
  const credentialRef = integration.credential_ref as string | null;
  if (credentialRef) { const t = Deno.env.get(`${credentialRef}_ACCESS_TOKEN`); if (t) return t; }
  return Deno.env.get("META_CONVERSIONS_ACCESS_TOKEN");
}

async function sendMetaConversion(integration: Record<string, unknown>, payload: Record<string, unknown>, _correlationId: string): Promise<{ status: number; body: string }> {
  const config = integration.config as Record<string, unknown>;
  const pixelId = config?.pixel_id as string;
  const accessToken = resolveMetaAccessToken(integration);
  if (!pixelId) throw new Error("Meta Conversions API: pixel_id not set in integration config");
  if (!accessToken) throw new Error("Meta Conversions API: access token not configured (checked credential_ref and fallback)");

  const eventName = payload.event_name as string || "Lead";
  const eventId = payload.event_id as string || crypto.randomUUID();
  const eventTime = payload.occurred_at ? Math.floor(new Date(payload.occurred_at as string).getTime() / 1000) : (payload.created_at ? Math.floor(new Date(payload.created_at as string).getTime() / 1000) : Math.floor(Date.now() / 1000));
  const emailHash = await hashSha256(payload.email as string);
  const phoneHash = await hashSha256(payload.phone as string);

  const eventData = { data: [{ event_name: eventName, event_id: eventId, event_time: eventTime, user_data: { em: emailHash ? [emailHash] : undefined, ph: phoneHash ? [phoneHash] : undefined }, action_source: "system_generated" }] };
  const apiUrl = `https://graph.facebook.com/v25.0/${pixelId}/events`;
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(eventData),
  });
  const body = await response.text();
  return { status: response.status, body: sanitizeProviderText(body) || "" };
}

interface GoogleCredentials { clientId: string; clientSecret: string; refreshToken: string }

function resolveGoogleCredentials(integration: Record<string, unknown>): GoogleCredentials {
  const credentialRef = integration.credential_ref as string | null;
  if (credentialRef) {
    const cId = Deno.env.get(`${credentialRef}_CLIENT_ID`);
    const cSec = Deno.env.get(`${credentialRef}_CLIENT_SECRET`);
    const rTok = Deno.env.get(`${credentialRef}_REFRESH_TOKEN`);
    if (cId && cSec && rTok) return { clientId: cId, clientSecret: cSec, refreshToken: rTok };
  }
  const clientId = Deno.env.get("GOOGLE_ADS_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_ADS_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_ADS_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Google Ads API: OAuth credentials not configured. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN or use credential_ref prefix.");
  return { clientId, clientSecret, refreshToken };
}

async function sendGoogleConversion(integration: Record<string, unknown>, payload: Record<string, unknown>, _correlationId: string): Promise<{ status: number; body: string }> {
  const config = integration.config as Record<string, unknown>;
  const customerId = config?.customer_id as string;
  const creds = resolveGoogleCredentials(integration);
  if (!customerId) throw new Error("Google Ads API: customer_id not set in integration config");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token" }),
  });
  if (!tokenResponse.ok) { const e = await tokenResponse.text(); throw new Error(`Google OAuth token refresh failed: ${e}`); }
  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;

  const gclid = payload.gclid as string | undefined;
  const conversionAction = config?.conversion_action_id as string;
  if (!conversionAction) throw new Error("Google Ads API: conversion_action_id not set in integration config");

  const emailHash = await hashSha256(payload.email as string);
  const phoneHash = await hashSha256(payload.phone as string);
  const eventDate = payload.occurred_at ? new Date(payload.occurred_at as string).toISOString() : (payload.created_at ? new Date(payload.created_at as string).toISOString() : new Date().toISOString());
  const currencyCode = (payload.currency_code as string) || (config?.currency_code as string) || "USD";
  const conversionVal = typeof payload.conversion_value === "number" ? payload.conversion_value : (typeof config?.default_conversion_value === "number" ? config.default_conversion_value : undefined);

  const conversionData = {
    conversions: [{
      conversion_action: `customers/${customerId}/conversionActions/${conversionAction}`,
      conversion_date_time: eventDate,
      conversion_value: conversionVal,
      currency_code: currencyCode,
      gclid: gclid || undefined,
      user_identifiers: [
        emailHash ? { user_identifier_type: "HASHED_EMAIL", hashed_email: emailHash } : null,
        phoneHash ? { user_identifier_type: "HASHED_PHONE_NUMBER", hashed_phone_number: phoneHash } : null,
      ].filter(Boolean),
    }],
  };

  const apiUrl = `https://googleads.googleapis.com/v18/customers/${customerId}:uploadClickConversions`;
  const headers: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` };
  const loginCustomerId = config?.login_customer_id as string;
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId.replace(/-/g, "");
  const developerToken = Deno.env.get("GOOGLE_ADS_DEVELOPER_TOKEN");
  if (developerToken) headers["developer-token"] = developerToken;

  const response = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(conversionData) });
  const responseText = await response.text();
  return { status: response.status, body: sanitizeProviderText(responseText) || "" };
}

async function hashSha256(value: string | undefined | null): Promise<string | null> {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}
