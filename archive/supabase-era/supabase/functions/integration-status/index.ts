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
      tenant_id: tenantId, severity, component: "edge_function",
      event_name: eventName, message, correlation_id: correlationId,
      context: { ...context, source: "integration-status" },
    });
  } catch { /* logging must never break the request */ }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

interface StatusResult {
  integration_id: string;
  provider: string;
  status: "connected" | "missing_config" | "auth_error" | "inactive" | "error";
  details: string;
  missing_fields: string[];
  checked_at: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const correlationId = crypto.randomUUID();

  try {
    const body = await req.json();
    const integrationId = body.integration_id as string;
    if (!integrationId) return new Response(JSON.stringify({ error: "Missing integration_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: integration, error } = await supabase
      .from("integrations").select("id, tenant_id, provider, config, status, credential_ref").eq("id", integrationId).maybeSingle();

    if (error || !integration) {
      await logEvent(null, "warn", "integration.status.not_found", `Integration ${integrationId} not found`, correlationId);
      return new Response(JSON.stringify({ error: "Integration not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Verify caller belongs to this tenant or is trusted worker
    const authHeader = req.headers.get("Authorization");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const cronSecret = Deno.env.get("CRON_SECRET");
    const workerSecret = req.headers.get("x-worker-secret");

    let isAuthorized = false;
    if (cronSecret && workerSecret && safeEqual(workerSecret, cronSecret)) {
      isAuthorized = true;
    } else if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.replace("Bearer ", "").trim();
      if (serviceRoleKey && safeEqual(token, serviceRoleKey)) {
        isAuthorized = true;
      } else {
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) {
          const { data: membership } = await supabase
            .from("tenant_memberships")
            .select("role")
            .eq("tenant_id", integration.tenant_id)
            .eq("user_id", user.id)
            .eq("status", "active")
            .maybeSingle();
          if (membership) {
            isAuthorized = true;
          }
        }
      }
    }

    if (!isAuthorized) {
      return new Response(JSON.stringify({ error: "Forbidden: insufficient permissions for this tenant integration" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await checkIntegrationStatus(integration);

    await supabase.from("integrations").update({
      last_health_check_at: new Date().toISOString(),
      last_error_at: result.status === "connected" ? null : new Date().toISOString(),
      last_error_detail: result.status === "connected" ? null : result.details,
    }).eq("id", integrationId);

    // Also write a system_health record for this check
    await supabase.from("system_health").insert({
      tenant_id: integration.tenant_id,
      component: "integration",
      component_id: integrationId,
      status: result.status === "connected" ? "healthy" : result.status === "missing_config" || result.status === "inactive" ? "degraded" : "failed",
      check_type: "connectivity",
      last_checked_at: result.checked_at,
      last_success_at: result.status === "connected" ? result.checked_at : null,
      last_error_at: result.status === "connected" ? null : result.checked_at,
      error_detail: result.status === "connected" ? null : result.details,
      metadata: { missing_fields: result.missing_fields, correlation_id: correlationId },
    });

    await logEvent(integration.tenant_id, result.status === "connected" ? "info" : "warn",
      `integration.status.${result.status}`, `${result.provider}: ${result.details}`, correlationId,
      { integration_id: integrationId, provider: result.provider, check_status: result.status });

    return new Response(JSON.stringify({ ...result, correlation_id: correlationId }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Integration status check error:", err);
    await logEvent(null, "error", "integration.status.error", err instanceof Error ? err.message : "Unknown error", correlationId);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function checkIntegrationStatus(integration: Record<string, unknown>): Promise<StatusResult> {
  const provider = integration.provider as string;
  const config = (integration.config as Record<string, unknown>) ?? {};
  const integrationId = integration.id as string;
  const checkedAt = new Date().toISOString();

  if (integration.status !== "active") {
    return { integration_id: integrationId, provider, status: "inactive", details: `Integration status is "${integration.status}", not "active"`, missing_fields: [], checked_at: checkedAt };
  }
  if (provider === "google_ads") return await checkGoogleAdsStatus(config, integrationId, checkedAt);
  if (provider === "meta_lead_ads") return checkMetaLeadAdsStatus(config, integrationId, checkedAt);
  if (provider === "meta_conversions") return await checkMetaConversionsStatus(integration, config, integrationId, checkedAt);
  if (provider === "google_enhanced_conversions") return await checkGoogleConversionsStatus(integration, config, integrationId, checkedAt);
  return { integration_id: integrationId, provider, status: "error", details: `Unknown provider: ${provider}`, missing_fields: [], checked_at: checkedAt };
}

async function checkGoogleAdsStatus(config: Record<string, unknown>, integrationId: string, checkedAt: string): Promise<StatusResult> {
  const missing: string[] = [];
  if (!config.google_key) missing.push("config.google_key");
  if (missing.length > 0) return { integration_id: integrationId, provider: "google_ads", status: "missing_config", details: "Webhook key not configured. Set google_key in the integration config.", missing_fields: missing, checked_at: checkedAt };
  return { integration_id: integrationId, provider: "google_ads", status: "connected", details: "Webhook key configured. Inbound lead webhooks will be accepted.", missing_fields: [], checked_at: checkedAt };
}

function checkMetaLeadAdsStatus(config: Record<string, unknown>, integrationId: string, checkedAt: string): StatusResult {
  const missing: string[] = [];
  if (!config.page_id) missing.push("config.page_id");
  const appSecret = Deno.env.get("META_APP_SECRET");
  if (!appSecret) missing.push("META_APP_SECRET (edge function secret)");
  if (missing.length > 0) return { integration_id: integrationId, provider: "meta_lead_ads", status: "missing_config", details: "Missing configuration for Meta Lead Ads webhook ingestion.", missing_fields: missing, checked_at: checkedAt };
  return { integration_id: integrationId, provider: "meta_lead_ads", status: "connected", details: "Page ID and app secret configured. Inbound lead webhooks will be accepted.", missing_fields: [], checked_at: checkedAt };
}

async function checkMetaConversionsStatus(integration: Record<string, unknown>, config: Record<string, unknown>, integrationId: string, checkedAt: string): Promise<StatusResult> {
  const missing: string[] = [];
  if (!config.pixel_id) missing.push("config.pixel_id");
  const credentialRef = integration.credential_ref as string | null;
  let accessToken: string | null = null;
  if (credentialRef) accessToken = Deno.env.get(`${credentialRef}_ACCESS_TOKEN`);
  if (!accessToken) accessToken = Deno.env.get("META_CONVERSIONS_ACCESS_TOKEN");
  if (!accessToken) { missing.push(credentialRef ? `${credentialRef}_ACCESS_TOKEN (edge function secret)` : "META_CONVERSIONS_ACCESS_TOKEN (edge function secret)"); }
  if (missing.length > 0) return { integration_id: integrationId, provider: "meta_conversions", status: "missing_config", details: "Meta Conversions API not fully configured.", missing_fields: missing, checked_at: checkedAt };

  try {
    const pixelId = config.pixel_id as string;
    const response = await fetch(`https://graph.facebook.com/v25.0/${pixelId}?fields=id,name&access_token=${accessToken}`, { method: "GET" });
    if (response.ok) {
      const data = await response.json();
      return { integration_id: integrationId, provider: "meta_conversions", status: "connected", details: `Connected to Pixel "${data.name ?? pixelId}". Token is valid.`, missing_fields: [], checked_at: checkedAt };
    } else {
      const errorBody = await response.text();
      const sanitizedError = errorBody.replace(/access_token=[^&"]+/g, "access_token=REDACTED");
      return { integration_id: integrationId, provider: "meta_conversions", status: "auth_error", details: `Meta API returned ${response.status}: ${sanitizedError.slice(0, 200)}`, missing_fields: [], checked_at: checkedAt };
    }
  } catch (err) {
    return { integration_id: integrationId, provider: "meta_conversions", status: "error", details: `Network error: ${err instanceof Error ? err.message : "Unknown"}`, missing_fields: [], checked_at: checkedAt };
  }
}

async function checkGoogleConversionsStatus(integration: Record<string, unknown>, config: Record<string, unknown>, integrationId: string, checkedAt: string): Promise<StatusResult> {
  const missing: string[] = [];
  if (!config.customer_id) missing.push("config.customer_id");
  if (!config.conversion_action_id) missing.push("config.conversion_action_id");
  const credentialRef = integration.credential_ref as string | null;
  let clientId: string | undefined, clientSecret: string | undefined, refreshToken: string | undefined;
  if (credentialRef) { clientId = Deno.env.get(`${credentialRef}_CLIENT_ID`); clientSecret = Deno.env.get(`${credentialRef}_CLIENT_SECRET`); refreshToken = Deno.env.get(`${credentialRef}_REFRESH_TOKEN`); }
  if (!clientId) clientId = Deno.env.get("GOOGLE_ADS_CLIENT_ID");
  if (!clientSecret) clientSecret = Deno.env.get("GOOGLE_ADS_CLIENT_SECRET");
  if (!refreshToken) refreshToken = Deno.env.get("GOOGLE_ADS_REFRESH_TOKEN");
  if (!clientId) missing.push(credentialRef ? `${credentialRef}_CLIENT_ID` : "GOOGLE_ADS_CLIENT_ID");
  if (!clientSecret) missing.push(credentialRef ? `${credentialRef}_CLIENT_SECRET` : "GOOGLE_ADS_CLIENT_SECRET");
  if (!refreshToken) missing.push(credentialRef ? `${credentialRef}_REFRESH_TOKEN` : "GOOGLE_ADS_REFRESH_TOKEN");
  if (missing.length > 0) return { integration_id: integrationId, provider: "google_enhanced_conversions", status: "missing_config", details: "Google Ads conversion upload not fully configured.", missing_fields: missing, checked_at: checkedAt };

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, refresh_token: refreshToken!, grant_type: "refresh_token" }),
    });
    if (tokenResponse.ok) {
      return { integration_id: integrationId, provider: "google_enhanced_conversions", status: "connected", details: "OAuth token refresh succeeded. Credentials are valid.", missing_fields: [], checked_at: checkedAt };
    } else {
      const tokenError = await tokenResponse.text();
      const sanitized = tokenError.replace(/"(client_secret|refresh_token|code)":"[^"]*"/g, '"$1":"REDACTED"');
      return { integration_id: integrationId, provider: "google_enhanced_conversions", status: "auth_error", details: `OAuth token refresh failed (${tokenResponse.status}): ${sanitized.slice(0, 200)}`, missing_fields: [], checked_at: checkedAt };
    }
  } catch (err) {
    return { integration_id: integrationId, provider: "google_enhanced_conversions", status: "error", details: `Network error: ${err instanceof Error ? err.message : "Unknown"}`, missing_fields: [], checked_at: checkedAt };
  }
}
