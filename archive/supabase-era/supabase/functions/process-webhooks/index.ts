import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, x-worker-secret",
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
      tenant_id: tenantId, severity, component: "webhook",
      event_name: eventName, message, correlation_id: correlationId,
      context: { ...context, source: "process-webhooks" },
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
      return { authorized: false, error: "Forbidden: insufficient role to process tenant queue", status: 403 };
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
    let query = supabase
      .from("webhook_inbox").select("*")
      .in("status", ["received", "retrying"])
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
      .order("received_at", { ascending: true })
      .limit(10);

    // Strict tenant isolation: operator-triggered worker ONLY processes their own tenant's items
    if (!callerAuth.isGlobalWorker && callerAuth.tenantId) {
      query = query.eq("tenant_id", callerAuth.tenantId);
    }

    const { data: events, error: fetchError } = await query;

    if (fetchError) {
      console.error("Failed to fetch events:", fetchError);
      await logEvent(callerAuth.tenantId ?? null, "error", "webhook.fetch_failed", fetchError.message, jobCorrelationId);
      return new Response(JSON.stringify({ error: "Failed to fetch events" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let processed = 0, failed = 0;
    for (const event of (events ?? [])) {
      const result = await processEvent(event, jobCorrelationId);
      if (result.success) processed++; else failed++;
    }

    const durationMs = Date.now() - startTime;
    await logEvent(callerAuth.tenantId ?? null, "info", "webhook.batch_complete", `Processed ${processed} events, ${failed} failed`, jobCorrelationId, {
      processed,
      failed,
      total: events?.length ?? 0,
      duration_ms: durationMs,
      is_global_worker: callerAuth.isGlobalWorker,
      operator_user_id: callerAuth.userId ?? null,
    });

    return new Response(JSON.stringify({ processed, failed, total: events?.length ?? 0, correlation_id: jobCorrelationId }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Processor error:", err);
    await logEvent(callerAuth.tenantId ?? null, "error", "webhook.processor_error", err instanceof Error ? err.message : "Unknown error", jobCorrelationId);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function processEvent(event: Record<string, unknown>, jobCorrelationId: string): Promise<{ success: boolean }> {
  const eventId = event.id as string;
  const tenantId = event.tenant_id as string;
  const provider = event.provider as string;
  const integrationId = event.integration_id as string;
  const retryCount = (event.retry_count as number) ?? 0;
  const maxRetries = (event.max_retries as number) ?? 5;
  const rawPayload = event.raw_payload as Record<string, unknown>;
  const eventCorrelationId = (rawPayload._correlation_id as string) || jobCorrelationId;

  const { data: claimed, error: claimError } = await supabase
    .from("webhook_inbox")
    .update({ status: "processing" })
    .eq("id", eventId)
    .in("status", ["received", "retrying"])
    .select("id");

  if (claimError || !claimed || claimed.length === 0) {
    // Another concurrent worker claimed this event or lease expired — safely yield
    return { success: false };
  }

  try {
    let firstName = "", lastName = "", email = "", phone = "", campaignId = "", formId = "", providerLeadId = "";

    if (provider === "google_ads") {
      const cols = (rawPayload.user_column_data as Array<{ column_id: string; string_value: string }>) ?? [];
      for (const col of cols) {
        const key = col.column_id?.toLowerCase() ?? "";
        const val = col.string_value ?? "";
        if (key === "given name" || key === "first name") firstName = val;
        else if (key === "family name" || key === "last name") lastName = val;
        else if (key === "email") email = val;
        else if (key === "phone number") phone = val;
        else if (key === "campaign id") campaignId = val;
        else if (key === "form id") formId = val;
      }
      providerLeadId = String(rawPayload.lead_id ?? "");
    } else if (provider === "meta_lead_ads") {
      const fieldData = (rawPayload.field_data as Array<{ name: string; values: string[] }>) ?? [];
      for (const field of fieldData) {
        const key = field.name?.toLowerCase() ?? "";
        const val = field.values?.[0] ?? "";
        if (key === "first_name" || key === "full_name") firstName = val;
        else if (key === "last_name") lastName = val;
        else if (key === "email") email = val;
        else if (key === "phone_number") phone = val;
      }
      providerLeadId = String(rawPayload.leadgen_id ?? rawPayload.id ?? "");
      campaignId = String(rawPayload.campaign_id ?? "");
      formId = String(rawPayload.form_id ?? "");
    }

    if (!firstName && !email && !phone) {
      await supabase.from("webhook_inbox").update({
        status: "rejected", error_detail: "No contact info extracted from payload", processed_at: new Date().toISOString(),
      }).eq("id", eventId);
      await logEvent(tenantId, "warn", "webhook.rejected_empty_payload", "No contact info in payload", eventCorrelationId, { event_id: eventId });
      return { success: false };
    }

    let contactId: string | null = null;
    const normalizedEmail = email ? email.toLowerCase().trim() : null;
    const normalizedPhone = phone ? phone.replace(/\D/g, "") : null;

    if (normalizedEmail) {
      const { data: existing } = await supabase
        .from("contacts").select("id").eq("tenant_id", tenantId).eq("email_normalized", normalizedEmail).maybeSingle();
      if (existing) contactId = existing.id;
    }
    if (!contactId && normalizedPhone) {
      const { data: existing } = await supabase
        .from("contacts").select("id").eq("tenant_id", tenantId).eq("phone_normalized", normalizedPhone).maybeSingle();
      if (existing) contactId = existing.id;
    }

    // Race-safe contact resolution: handle 23505 conflict by re-querying existing contact
    if (!contactId) {
      const { data: newContact, error: contactError } = await supabase
        .from("contacts").insert({
          tenant_id: tenantId, first_name: firstName || "Unknown",
          last_name: lastName || null, email: email || null,
          email_normalized: normalizedEmail, phone: phone || null,
          phone_normalized: normalizedPhone,
          source_summary: { initial_source: provider, created_via: "webhook_ingestion" },
        }).select("id").single();

      if (contactError) {
        if (contactError.code === "23505") {
          let refetchQuery = supabase.from("contacts").select("id").eq("tenant_id", tenantId);
          if (normalizedEmail) refetchQuery = refetchQuery.eq("email_normalized", normalizedEmail);
          else if (normalizedPhone) refetchQuery = refetchQuery.eq("phone_normalized", normalizedPhone);
          const { data: racedContact } = await refetchQuery.maybeSingle();
          if (racedContact) {
            contactId = racedContact.id;
          } else {
            throw new Error(`Contact creation conflict: ${contactError.message}`);
          }
        } else {
          throw new Error(`Contact creation failed: ${contactError.message}`);
        }
      } else {
        contactId = newContact.id;
      }
    }

    const { data: defaultPipeline } = await supabase
      .from("pipelines").select("id").eq("tenant_id", tenantId).eq("is_default", true).maybeSingle();

    const pipelineId = defaultPipeline?.id ?? null;
    let stageId: string | null = null;
    if (pipelineId) {
      const { data: firstStage } = await supabase
        .from("pipeline_stages").select("id").eq("pipeline_id", pipelineId).eq("stage_key", "new").maybeSingle();
      stageId = firstStage?.id ?? null;
    }

    const { data: lead, error: leadError } = await supabase
      .from("leads").insert({
        tenant_id: tenantId, contact_id: contactId,
        pipeline_id: pipelineId, pipeline_stage_id: stageId,
        stage: "new", lead_source: provider,
        title: `${firstName} ${lastName}`.trim() || `Lead from ${provider}`,
      }).select("id").single();

    if (leadError) throw new Error(`Lead creation failed: ${leadError.message}`);

    // Marketing attribution record: capture campaign, form, and click/UTM tracking safely
    await supabase.from("marketing_attribution").insert({
      tenant_id: tenantId,
      lead_id: lead.id,
      touch_type: "first_touch",
      source: provider,
      campaign_id: campaignId || (rawPayload.campaign_id as string) || null,
      form_id: formId || (rawPayload.form_id as string) || null,
      integration_id: integrationId || null,
      is_direct: true,
      gclid: (rawPayload.gclid as string) || null,
      fbclid: (rawPayload.fbclid as string) || null,
      utm_source: (rawPayload.utm_source as string) || provider,
      utm_medium: (rawPayload.utm_medium as string) || "cpc",
      utm_campaign: (rawPayload.utm_campaign as string) || campaignId || null,
      utm_term: (rawPayload.utm_term as string) || null,
      utm_content: (rawPayload.utm_content as string) || null,
    });

    await supabase.from("activities").insert({
      tenant_id: tenantId, lead_id: lead.id, contact_id: contactId,
      type: "system", direction: "inbound",
      subject: `Lead ingested from ${provider}`,
      content: `Automatic ingestion via webhook. Provider Lead ID: ${providerLeadId}`,
      is_internal: true,
    });

    await supabase.from("webhook_inbox").update({
      status: "completed", processed_at: new Date().toISOString(), error_detail: null,
    }).eq("id", eventId);

    await logEvent(tenantId, "info", "webhook.lead_created", `Lead ${lead.id} created from ${provider}`, eventCorrelationId, {
      lead_id: lead.id, contact_id: contactId, provider, provider_lead_id: providerLeadId,
    });

    return { success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Processing error";
    const newRetryCount = retryCount + 1;
    const isExhausted = newRetryCount >= maxRetries;
    const backoffSeconds = Math.min(30 * Math.pow(2, newRetryCount), 3600);
    const nextAttempt = new Date(Date.now() + backoffSeconds * 1000).toISOString();

    await supabase.from("webhook_inbox").update({
      status: isExhausted ? "dead_letter" : "retrying",
      retry_count: newRetryCount,
      error_detail: errorMsg,
      next_attempt_at: isExhausted ? null : nextAttempt,
    }).eq("id", eventId);

    await logEvent(tenantId, isExhausted ? "error" : "warn",
      isExhausted ? "webhook.dead_lettered" : "webhook.retry_scheduled",
      errorMsg, eventCorrelationId, { event_id: eventId, retry_count: newRetryCount, max_retries: maxRetries, next_attempt_at: nextAttempt });

    return { success: false };
  }
}
