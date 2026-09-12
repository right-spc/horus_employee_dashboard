// ============================================
  // EDGE FUNCTION: dashboard-api
  // Authenticated gateway for the dashboard.
  // Receives user JWT, enforces role-based access,
  // and proxies all DB operations server-side.
  // The service role key never reaches the client.
  // ============================================

  import { createClient } from "npm:@supabase/supabase-js@2";

  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  const ADDON_CREDITS = 1000;   // Credits granted by the $59 addon
  const GRACE_PERIOD_DAYS = 7;  // Days after subscription_end_date before suspension

  // PayPal API base — set to https://api-m.paypal.com for live, sandbox by default
  const PAYPAL_BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.sandbox.paypal.com";

  // Use APP_ overrides when the SUPABASE_ auto-managed secrets have been
  // accidentally overwritten by a CLI deploy; fall back gracefully once restored.
  const SUPA_URL = Deno.env.get("APP_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!;
  const SUPA_ANON_KEY = Deno.env.get("APP_ANON_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPA_SERVICE_KEY = Deno.env.get("APP_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Shared secret for server-to-server calls between our edge functions
  // (function envs can hold a different-but-valid service key than the
  // project's current one, so exact service-key matching is unreliable).
  const INTERNAL_SECRET = Deno.env.get("INTERNAL_FUNCTION_SECRET");

  // Preset categories the salesperson role is allowed to charge for.
  // Salespeople can ONLY send setup-fee and yearly links — no monthly, no addon, no custom.
  const SALESPERSON_PRESETS = new Set(["setup", "yearly"]);
  const OWNER_PRESETS = new Set(["setup", "monthly", "yearly", "addon", "custom"]);

  // Table → schema lookup for the dynamic delete loops (tables moved out of public 2026-09-07).
  const TABLE_SCHEMA: Record<string, string> = {
    organizations: "core", organization_members: "core", dashboard_users: "core", customer_users: "core", widget_configs: "core", demo_defaults: "core",
    clients: "core", client_members: "core", org_notes: "core",
    contacts: "crm", contact_aliases: "crm",
    conversations: "messaging", messages: "messaging", conversation_merges: "messaging", delivery_queue: "messaging", widget_surveys: "messaging",
    kb_amend_requests: "kb", kb_versions: "kb",
    business_profiles: "business", business_services: "business", business_hours: "business", business_staff: "business",
    email_providers: "comms", integrations: "comms", notification_recipients: "comms", export_schedules: "comms",
    payment_history: "billing", credit_cycle_history: "billing",
    analytics_events: "analytics", analytics_daily: "analytics", analytics_hourly: "analytics", audit_logs: "analytics",
    rate_limit_buckets: "system",
  };

  // Compute the next run timestamp for an export schedule. Aligned to 00:00 UTC
  // so each scheduled run lines up exactly with the cron-maintenance tick (which
  // fires at 0 0 * * *). Setting any later hour would cause daily schedules to
  // fire every other day instead of every day.
  function computeNextRunAt(
    frequency: "daily" | "weekly" | "monthly" | "quarterly",
    from: Date
  ): Date {
    const d = new Date(from);
    d.setUTCHours(0, 0, 0, 0);
    const days = { daily: 1, weekly: 7, monthly: 30, quarterly: 90 }[frequency];
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  }

  // Extend a date by one calendar month, clamped to the last day of the resulting month.
  // e.g. Jan 31 → Feb 28 (or Feb 29 in leap years).
  function addCalendarMonths(date: Date, months: number): Date {
    const d = new Date(date);
    const targetMonth = d.getMonth() + months;
    const targetYear = d.getFullYear() + Math.floor(targetMonth / 12);
    const targetMonthNormalized = ((targetMonth % 12) + 12) % 12;
    const originalDay = d.getDate();
    d.setDate(1);
    d.setFullYear(targetYear, targetMonthNormalized, 1);
    const lastDayOfMonth = new Date(targetYear, targetMonthNormalized + 1, 0).getDate();
    d.setDate(Math.min(originalDay, lastDayOfMonth));
    return d;
  }

  // ── Types ─────────────────────────────────────────────────────────────────────

  interface DashboardUser {
    id: string;
    display_name: string;
    role: "owner" | "salesperson";
    is_active: boolean;
  }

  // ── Main Handler ─────────────────────────────────────────────────────────────

  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // ── Authenticate user ─────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return err("Missing authorization header", 401);
    }

    const userJwt = authHeader.slice(7);

    // Create a client scoped to the user's JWT — this respects RLS
    const userClient = createClient(
      SUPA_URL,
      SUPA_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
    );

    // Create a service role client for privileged operations
    const adminClient = createClient(
      SUPA_URL,
      SUPA_SERVICE_KEY
    );

    // Get authenticated user
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return err("Invalid or expired token", 401);
    }

    // Look up dashboard user record and role
    const { data: dashUser, error: dashError } = await adminClient
      .schema("core").from("dashboard_users")
      .select("id, display_name, role, is_active")
      .eq("id", user.id)
      .single<DashboardUser>();

    if (dashError && dashError.code !== "PGRST116") {
      // Real DB/PostgREST failure (e.g. schema cache outage) — not an auth issue.
      // PGRST116 = "0 rows" from .single(), i.e. genuinely no dashboard account.
      console.error("dashboard_users lookup failed:", JSON.stringify(dashError));
      return err("Service temporarily unavailable — please try again later", 500);
    }

    if (!dashUser) {
      return err("Access denied — no dashboard account found", 403);
    }

    if (!dashUser.is_active) {
      return err("Account is disabled", 403);
    }

    // ── Parse request ─────────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return err("Invalid JSON", 400);
    }

    const action = body.action as string;
    if (!action) return err("Missing action", 400);

    const isOwner = dashUser.role === "owner";

    // ── Route actions ─────────────────────────────────────────────────────────
    try {
      switch (action) {

        // ── Get current user info ───────────────────────────────────────────
        case "me": {
          return ok({ user: dashUser });
        }

        // ── List organizations ──────────────────────────────────────────────
        case "list_orgs": {
          let query = adminClient
            .schema("core").from("organizations")
            .select(`
              id, name, slug, subscription_status, subscription_tier,
              subscription_plan, subscription_start_date, subscription_end_date,
              messages_used_this_month, message_limit_per_month,
              limit_exceeded_at, created_at, created_by, created_by_name,
              ai_responses_enabled
            `)
            .eq("is_demo", false)
            .order("created_at", { ascending: false });

          if (!isOwner) {
            // Salespeople only see orgs they created today (US Pacific time)
            const todayStartLocal = getTodayStartUS();
            query = query
              .eq("created_by", dashUser.id)
              .gte("created_at", todayStartLocal);
          }

          const { data, error } = await query;
          if (error) throw error;

          // Also fetch provider and widget status
          const orgIds = (data || []).map(o => o.id);
          if (orgIds.length === 0) return ok({ orgs: [], providers: [], widgets: [] });

          const [{ data: providers }, { data: widgets }] = await Promise.all([
            adminClient.schema("comms").from("email_providers")
              .select("organization_id, provider, status, provider_account_email, watch_expiry, emails_sent_today, daily_send_limit")
              .in("organization_id", orgIds),
            adminClient.schema("core").from("widget_configs")
              .select("organization_id, enabled, api_key")
              .in("organization_id", orgIds),
          ]);

          return ok({ orgs: data, providers: providers || [], widgets: widgets || [] });
        }

        // ── List clients with their organizations ───────────────────────────
        case "list_clients": {
          if (!isOwner) return err("Only owners can list clients", 403);

          const [
            { data: clients, error: clientsErr },
            { data: members, error: membersErr },
            { data: orgs, error: orgsErr },
          ] = await Promise.all([
            adminClient.schema("core").from("clients")
              .select("id, name, notes, owner_id, created_at")
              .order("name"),
            adminClient.schema("core").from("client_members")
              .select("client_id, email, role"),
            adminClient.schema("core").from("organizations")
              .select("id, name, slug, client_id, subscription_status, subscription_end_date")
              .eq("is_demo", false)
              .order("name"),
          ]);
          if (clientsErr) throw clientsErr;
          if (membersErr) throw membersErr;
          if (orgsErr) throw orgsErr;

          // Owner display (email) for each client's owner_id
          const ownerIds = [...new Set((clients || []).map(c => c.owner_id).filter(Boolean))];
          let owners: Array<{ id: string; email: string }> = [];
          if (ownerIds.length > 0) {
            const { data: ownerRows, error: ownersErr } = await adminClient
              .schema("core").from("customer_users")
              .select("id, email")
              .in("id", ownerIds);
            if (ownersErr) throw ownersErr;
            owners = ownerRows || [];
          }

          return ok({ clients: clients || [], members: members || [], orgs: orgs || [], owners });
        }

        // ── Get single org ──────────────────────────────────────────────────
        case "get_org": {
          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const [
            { data: org, error: orgErr },
            { data: providers },
            { data: widget },
            { data: lastPayment },
            { data: notes },
          ] = await Promise.all([
            adminClient.schema("core").from("organizations").select("*").eq("id", org_id).single(),
            adminClient.schema("comms").from("email_providers").select("*").eq("organization_id", org_id),
            adminClient.schema("core").from("widget_configs").select("*").eq("organization_id", org_id).maybeSingle(),
            adminClient.schema("billing").from("payment_history")
              .select("created_at, category, amount")
              .eq("organization_id", org_id)
              .eq("status", "completed")
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle(),
            adminClient.schema("core").from("org_notes")
              .select("id, body, created_by, created_by_name, created_at")
              .eq("organization_id", org_id)
              .order("created_at", { ascending: false })
              .limit(100),
          ]);

          if (orgErr) throw orgErr;

          // Conversation stats for the current billing cycle (counts only, never
          // content). Cycle resets on cycle_anchor_day (fallback: billing day).
          const resetDay = Number(org?.cycle_anchor_day ?? org?.billing_day_of_month ?? 1) || 1;
          const nowUtc = new Date();
          const cycleStart = nowUtc.getUTCDate() >= resetDay
            ? new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), resetDay))
            : new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() - 1, resetDay));
          const cycleStartIso = cycleStart.toISOString();
          const convCount = (channel: string) =>
            adminClient.schema("messaging").from("conversations")
              .select("id", { count: "exact", head: true })
              .eq("organization_id", org_id)
              .eq("channel", channel)
              .gte("created_at", cycleStartIso);
          const [{ count: webchatCount }, { count: emailCount }] = await Promise.all([
            convCount("webchat"),
            convCount("email"),
          ]);
          const conversationStats = {
            cycle_start: cycleStartIso,
            reset_day: resetDay,
            webchat: webchatCount ?? 0,
            email: emailCount ?? 0,
          };

          // Linked client (identity line on the Overview tab)
          let client: { id: string; name: string } | null = null;
          if (org?.client_id) {
            const { data: clientRow } = await adminClient
              .schema("core").from("clients")
              .select("id, name")
              .eq("id", org.client_id)
              .maybeSingle();
            client = clientRow;
          }

          // kbDocs shim: the org now has ONE whole-KB version history. Expose
          // the active version as a single pseudo-document so the existing KB
          // tab keeps working until the Phase 2 sections-editor rewrite.
          let kbDocs: Array<Record<string, unknown>> = [];
          if (org?.active_kb_version_id) {
            const { data: activeVersion } = await adminClient
              .schema("kb").from("kb_versions")
              .select("id, version, created_at")
              .eq("id", org.active_kb_version_id)
              .single();
            if (activeVersion) {
              kbDocs = [{
                id: activeVersion.id,
                title: "Knowledge Base",
                file_type: "markdown",
                status: "ready",
                created_at: activeVersion.created_at,
                version: activeVersion.version,
              }];
            }
          }

          return ok({ org, providers: providers || [], widget, kbDocs, lastPayment, conversationStats, client, notes: notes || [] });
        }

        // ── Add org note (account history) ──────────────────────────────────
        case "add_org_note": {
          const { org_id, body: noteBody } = body;
          if (!org_id) return err("Missing org_id", 400);
          const text = String(noteBody || "").trim();
          if (!text) return err("Note cannot be empty", 400);
          if (text.length > 2000) return err("Note too long (max 2000 chars)", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data: note, error: noteErr } = await adminClient
            .schema("core").from("org_notes")
            .insert({
              organization_id: org_id,
              body: text,
              created_by: dashUser.id,
              created_by_name: dashUser.display_name || null,
            })
            .select("id, body, created_by, created_by_name, created_at")
            .single();
          if (noteErr) throw noteErr;
          return ok({ note });
        }

        // ── Delete org note (author or owner) ───────────────────────────────
        case "delete_org_note": {
          const { org_id, note_id } = body;
          if (!org_id || !note_id) return err("Missing org_id or note_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data: note, error: fetchErr } = await adminClient
            .schema("core").from("org_notes")
            .select("id, created_by")
            .eq("id", note_id)
            .eq("organization_id", org_id)
            .maybeSingle();
          if (fetchErr) throw fetchErr;
          if (!note) return err("Note not found", 404);
          if (!isOwner && note.created_by !== dashUser.id) {
            return err("Only the author or an owner can delete a note", 403);
          }

          const { error: delErr } = await adminClient
            .schema("core").from("org_notes")
            .delete()
            .eq("id", note_id);
          if (delErr) throw delErr;
          return ok({ success: true });
        }

        // ── Test chat (employee AI playground) ──────────────────────────────
        // Proxies to widget-chat's test mode with the service key. The real AI
        // pipeline runs (org config, KB, prompt, Kimi) but nothing persists and
        // no usage/credits are consumed. History is client-supplied, bounded.
        case "test_chat": {
          const { org_id, message, history, stream } = body as {
            org_id: string; message: string; history?: Array<{ role: string; content: string }>; stream?: boolean;
          };
          if (!org_id || !String(message || "").trim()) {
            return err("Missing org_id or message", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const res = await fetch(`${SUPA_URL}/functions/v1/widget-chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${INTERNAL_SECRET ?? SUPA_SERVICE_KEY}`,
            },
            body: JSON.stringify({
              test_mode: true,
              org_id,
              message: String(message).slice(0, 2000),
              history: Array.isArray(history) ? history.slice(-20) : [],
              ...(stream === true ? { stream: true } : {}),
            }),
          });
          // Streaming mode: pipe widget-chat's SSE body straight through to the
          // browser unchanged (delta/done events — see widget-chat).
          if (stream === true) {
            if (!res.ok || !res.body) {
              const payload = await res.json().catch(() => ({}));
              return err(payload.error || "Test chat failed", res.status);
            }
            return new Response(res.body, {
              status: 200,
              headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
            });
          }
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) return err(payload.error || "Test chat failed", res.status);
          return ok(payload);
        }

        // ── Create org ──────────────────────────────────────────────────────
        case "create_org": {
          const { name, slug, ai_tone, message_limit_per_month, auto_send_min_confidence, subscription_tier, subscription_plan } = body;

          if (!name || !slug) return err("Missing name or slug", 400);

          // Salespeople cannot set message_limit_per_month — use default
          const limit = isOwner
            ? (message_limit_per_month as number ?? 7500)
            : 7500;

          const isSalespersonCreated = !isOwner;

          // Compute subscription dates
          const plan = (subscription_plan as string) === "yearly" ? "yearly" : "monthly";
          const now = new Date();
          const subscriptionStart = now.toISOString();
          // Yearly plan grants 14 months of service (2 bonus months as advertised).
          const endDate = plan === "yearly"
            ? addCalendarMonths(now, 14)
            : addCalendarMonths(now, 1);
          const subscriptionEnd = endDate.toISOString();

          // Default billing_day_of_month to today's day-of-month, clamped to 28.
          // The reset cycle is derived from the day-of-month of
          // subscription_end_date, not stored separately.
          const billingDay = Math.min(now.getUTCDate(), 28);

          const { data: org, error: orgErr } = await adminClient
            .schema("core").from("organizations")
            .insert({
              name, slug,
              ai_tone: ai_tone || "professional",
              message_limit_per_month: limit,
              monthly_credits_remaining: limit,
              auto_send_min_confidence: auto_send_min_confidence || 0.75,
              subscription_tier: subscription_tier || "basic",
              subscription_plan: plan,
              subscription_start_date: subscriptionStart,
              subscription_end_date: subscriptionEnd,
              billing_day_of_month: billingDay,
              auto_send_enabled: false,
              ai_responses_enabled: false,
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select()
            .single();

          if (orgErr) throw orgErr;

          // Auto-create widget config (disabled for salesperson-created orgs)
          await adminClient.schema("core").from("widget_configs").insert({
            organization_id: org.id,
            enabled: false,
            disable_reason: "pending_activation",
          });

          return ok({ org });
        }

        // ── Update org settings ─────────────────────────────────────────────
        case "update_org": {
          const { org_id, updates } = body as { org_id: string; updates: Record<string, unknown> };
          if (!org_id || !updates) return err("Missing org_id or updates", 400);

          await assertOrgAccess(adminClient, dashUser, org_id);

          if (!isOwner) {
            delete updates.message_limit_per_month;
            delete updates.subscription_plan;
            delete updates.subscription_start_date;
            delete updates.subscription_end_date;
            delete updates.billing_day_of_month;
            delete updates.rollover_credits;
            delete updates.monthly_credits_remaining;
            delete updates.addon_credits;
            delete updates.auto_send_min_confidence;
            delete updates.retention_days;

            // For demo orgs, salespeople can only edit ai_tone
            const { data: orgCheck } = await adminClient
              .schema("core").from("organizations")
              .select("is_demo")
              .eq("id", org_id)
              .single();

            if (orgCheck?.is_demo) {
              const allowed = ["ai_tone"];
              for (const key of Object.keys(updates)) {
                if (!allowed.includes(key)) delete updates[key];
              }
            }
          }

          // Validate billing day if present
          if (typeof updates.billing_day_of_month !== "undefined") {
            const day = Number(updates.billing_day_of_month);
            if (!Number.isInteger(day) || day < 1 || day > 28) {
              return err("billing_day_of_month must be an integer 1-28", 400);
            }
            updates.billing_day_of_month = day;
          }

          // Validate message retention period if present
          if (typeof updates.retention_days !== "undefined") {
            const days = Number(updates.retention_days);
            if (![3, 7, 30, 365].includes(days)) {
              return err("retention_days must be one of 3, 7, 30, or 365", 400);
            }
            updates.retention_days = days;
          }

          const { error } = await adminClient
            .schema("core").from("organizations")
            .update(updates)
            .eq("id", org_id);

          if (error) throw error;
          return ok({ success: true });
        }

        // ── Update widget config ────────────────────────────────────────────
        case "update_widget": {
          const { org_id, updates } = body as { org_id: string; updates: Record<string, unknown> };
          if (!org_id || !updates) return err("Missing org_id or updates", 400);

          await assertOrgAccess(adminClient, dashUser, org_id);

          if (!isOwner) {
            delete updates.enabled;
            delete updates.disable_reason;
            delete updates.disable_message;
          }

          const { error } = await adminClient
            .schema("core").from("widget_configs")
            .update(updates)
            .eq("organization_id", org_id);

          if (error) throw error;
          return ok({ success: true });
        }

        // ── Get auth link ───────────────────────────────────────────────────
        case "get_auth_link": {
          const { org_id, provider } = body;
          if (!org_id || !provider) return err("Missing org_id or provider", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const fnName = provider === "google" ? "auth-google" : "auth-microsoft";
          const res = await fetch(`${SUPA_URL}/functions/v1/${fnName}`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${SUPA_SERVICE_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ organization_id: org_id }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || data.message || `Auth function returned HTTP ${res.status}`);
          return ok({ url: data.url });
        }

        // ── KB ingest (proxied to kb-ingest, which creates a new KB version) ──
        case "kb_ingest": {
          const { org_id, ...payload } = body as Record<string, unknown>;
          if (!org_id) return err("Missing org_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const res = await fetch(`${SUPA_URL}/functions/v1/kb-ingest`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${SUPA_SERVICE_KEY}`,
              "x-internal-secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...payload,
              organization_id: org_id,
              source: "dashboard",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            }),
          });

          const responseText = await res.text();
          console.log("kb-ingest response:", res.status, responseText);
          if (!res.ok) {
            let errorMsg = "KB ingest failed";
            try { errorMsg = JSON.parse(responseText).error || JSON.parse(responseText).msg || responseText; } catch { errorMsg = responseText || errorMsg; }
            throw new Error(errorMsg);
          }
          const data = JSON.parse(responseText);
          return ok(data);
        }

        // ── Delete KB document ──────────────────────────────────────────────
        case "delete_kb_doc": {
          const { org_id, doc_id } = body;
          if (!org_id || !doc_id) return err("Missing org_id or doc_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          // Versioned KB rows are immutable history — they cannot be deleted.
          const { data: versionRow } = await adminClient
            .schema("kb").from("kb_versions")
            .select("id")
            .eq("id", doc_id)
            .maybeSingle();
          if (versionRow) {
            return err("The versioned knowledge base cannot be deleted — edit it (creates a new version) or roll back to a previous version instead.", 400);
          }

          return err("Legacy KB documents were retired in the versioned-KB migration — nothing to delete.", 400);
        }

        // ── Get KB content (legacy shape, kept for compatibility) ───────────
        // doc_id is the KB VERSION id. Sections are returned chunk-shaped.
        case "get_kb_chunks": {
          const { org_id, doc_id } = body;
          if (!org_id || !doc_id) return err("Missing org_id or doc_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data: version, error } = await adminClient
            .schema("kb").from("kb_versions")
            .select("id, sections")
            .eq("id", doc_id)
            .eq("organization_id", org_id)
            .single();

          if (error || !version) return err("KB version not found", 404);

          const sections = (version.sections as Array<{ title?: string; body?: string }>) || [];
          const chunks = sections.map((s, i) => ({
            content: s.title ? `## ${s.title}\n\n${s.body ?? ""}` : (s.body ?? ""),
            chunk_index: i,
          }));
          return ok({ chunks });
        }

        // ── List KB versions (history) ──────────────────────────────────────
        case "list_kb_versions": {
          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data, error } = await adminClient
            .schema("kb").from("kb_versions")
            .select("id, version, change_summary, source, created_by_name, created_at")
            .eq("organization_id", org_id)
            .order("version", { ascending: false });

          if (error) throw error;
          return ok({ versions: data || [] });
        }

        // ── Get one KB version (full sections) ──────────────────────────────
        case "get_kb_version": {
          const { org_id, version_id } = body;
          if (!org_id || !version_id) return err("Missing org_id or version_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data, error } = await adminClient
            .schema("kb").from("kb_versions")
            .select("id, version, sections, change_summary, source, created_by_name, created_at")
            .eq("id", version_id)
            .eq("organization_id", org_id)
            .single();

          if (error || !data) return err("KB version not found", 404);
          return ok({ version: data });
        }

        // ── Save KB sections as a new version (sections editor) ─────────────
        case "save_kb_sections": {
          const { org_id, sections, change_summary } = body as {
            org_id?: string;
            sections?: Array<{ title?: string; body?: string }>;
            change_summary?: string;
          };
          if (!org_id || !Array.isArray(sections)) return err("Missing org_id or sections", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const clean = sections
            .map(s => ({ title: String(s?.title ?? "").trim(), body: String(s?.body ?? "").trim() }))
            .filter(s => s.title || s.body);

          const { data: maxRow } = await adminClient
            .schema("kb").from("kb_versions")
            .select("version")
            .eq("organization_id", org_id)
            .order("version", { ascending: false })
            .limit(1)
            .maybeSingle();

          const { data: newVersion, error } = await adminClient
            .schema("kb").from("kb_versions")
            .insert({
              organization_id: org_id,
              version: (maxRow?.version ?? 0) + 1,
              sections: clean,
              change_summary: change_summary?.trim() || "Edited knowledge base",
              source: "dashboard",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select("id, version")
            .single();
          if (error) throw error;

          await adminClient.schema("core").from("organizations")
            .update({ active_kb_version_id: newVersion.id })
            .eq("id", org_id);

          return ok({ version_id: newVersion.id, version: newVersion.version });
        }

        // ── Rollback: new version copying an old version's sections ─────────
        // The pointer never moves backwards — history stays append-only.
        case "rollback_kb_version": {
          const { org_id, version_id } = body;
          if (!org_id || !version_id) return err("Missing org_id or version_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data: target, error: targetErr } = await adminClient
            .schema("kb").from("kb_versions")
            .select("version, sections")
            .eq("id", version_id)
            .eq("organization_id", org_id)
            .single();
          if (targetErr || !target) return err("KB version not found", 404);

          const { data: maxRow } = await adminClient
            .schema("kb").from("kb_versions")
            .select("version")
            .eq("organization_id", org_id)
            .order("version", { ascending: false })
            .limit(1)
            .maybeSingle();

          const { data: newVersion, error } = await adminClient
            .schema("kb").from("kb_versions")
            .insert({
              organization_id: org_id,
              version: (maxRow?.version ?? 0) + 1,
              sections: target.sections,
              change_summary: `Rollback to v${target.version}`,
              source: "dashboard",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select("id, version")
            .single();
          if (error) throw error;

          await adminClient.schema("core").from("organizations")
            .update({ active_kb_version_id: newVersion.id })
            .eq("id", org_id);

          return ok({ version_id: newVersion.id, version: newVersion.version });
        }

        // ── List KB amend requests (employee review) ────────────────────────
        case "list_kb_amend_requests": {
          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data, error } = await adminClient
            .schema("kb").from("kb_amend_requests")
            .select("id, title, content, status, reviewer_notes, created_at")
            .eq("organization_id", org_id)
            .order("created_at", { ascending: false });

          if (error) throw error;
          return ok({ requests: data || [] });
        }

        // ── Review a KB amend request (apply → new version, or dismiss) ─────
        case "review_kb_amend": {
          const { org_id, request_id, action, reviewer_notes } = body as {
            org_id?: string; request_id?: string; action?: string; reviewer_notes?: string;
          };
          if (!org_id || !request_id) return err("Missing org_id or request_id", 400);
          if (action !== "apply" && action !== "dismiss") return err("action must be 'apply' or 'dismiss'", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data: request, error: reqErr } = await adminClient
            .schema("kb").from("kb_amend_requests")
            .select("id, title, content, status")
            .eq("id", request_id)
            .eq("organization_id", org_id)
            .single();
          if (reqErr || !request) return err("Amend request not found", 404);
          if (request.status !== "pending") return err("Request already reviewed", 400);

          if (action === "dismiss") {
            const { error } = await adminClient
              .schema("kb").from("kb_amend_requests")
              .update({ status: "dismissed", reviewer_notes: reviewer_notes || null })
              .eq("id", request_id);
            if (error) throw error;
            return ok({ success: true });
          }

          // Apply: append the request as a new section in a new version
          const { data: org } = await adminClient
            .schema("core").from("organizations")
            .select("active_kb_version_id")
            .eq("id", org_id)
            .single();

          let currentSections: unknown[] = [];
          if (org?.active_kb_version_id) {
            const { data: activeVersion } = await adminClient
              .schema("kb").from("kb_versions")
              .select("sections")
              .eq("id", org.active_kb_version_id)
              .single();
            currentSections = (activeVersion?.sections as unknown[]) || [];
          }

          const { data: maxRow } = await adminClient
            .schema("kb").from("kb_versions")
            .select("version")
            .eq("organization_id", org_id)
            .order("version", { ascending: false })
            .limit(1)
            .maybeSingle();

          const { data: newVersion, error } = await adminClient
            .schema("kb").from("kb_versions")
            .insert({
              organization_id: org_id,
              version: (maxRow?.version ?? 0) + 1,
              sections: [...currentSections, { title: request.title, body: request.content }],
              change_summary: `Applied amend request: ${request.title}`,
              source: "customer_amend",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select("id, version")
            .single();
          if (error) throw error;

          await adminClient.schema("core").from("organizations")
            .update({ active_kb_version_id: newVersion.id })
            .eq("id", org_id);

          await adminClient.schema("kb").from("kb_amend_requests")
            .update({
              status: "applied",
              applied_version_id: newVersion.id,
              reviewer_notes: reviewer_notes || null,
            })
            .eq("id", request_id);

          return ok({ version_id: newVersion.id, version: newVersion.version });
        }

        // ── Reset usage ─────────────────────────────────────────────────────
        case "reset_usage": {
          if (!isOwner) return err("Only owners can reset usage", 403);

          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          const { error: orgErr } = await adminClient
            .schema("core").from("organizations")
            .update({ messages_used_this_month: 0, limit_exceeded_at: null, limit_notified_at: null })
            .eq("id", org_id);

          if (orgErr) throw orgErr;

          await adminClient
            .schema("core").from("widget_configs")
            .update({ enabled: true, disable_reason: null, disable_message: null })
            .eq("organization_id", org_id)
            .eq("disable_reason", "usage_limit");

          return ok({ success: true });
        }

        // ── Renew subscription ─────────────────────────────────────────────
        case "renew_subscription": {
          if (!isOwner) return err("Only owners can renew subscriptions", 403);

          const { org_id, plan } = body as { org_id: string; plan?: string };
          if (!org_id) return err("Missing org_id", 400);

          const result = await extendSubscription(adminClient, org_id, plan);
          if (!result.ok) return err(result.error!, result.status!);

          return ok({ success: true, new_end_date: result.newEndDate });
        }

        // ── Sales report (owner only) ───────────────────────────────────────
        case "sales_report": {
          if (!isOwner) return err("Only owners can view sales reports", 403);

          const { data, error } = await adminClient
            .schema("core").from("organizations")
            .select("id, name, created_at, created_by, created_by_name, subscription_tier, subscription_plan, subscription_end_date, messages_used_this_month")
            .not("created_by", "is", null)
            .eq("is_demo", false)
            .order("created_at", { ascending: false });

          if (error) throw error;
          return ok({ orgs: data });
        }

        // ── Message export: on-demand ───────────────────────────────────────
        case "export_messages": {
          const { org_id, start_date, end_date, recipient_email } = body as {
            org_id: string;
            start_date: string;
            end_date: string;
            recipient_email?: string;
          };
          if (!org_id || !start_date || !end_date) {
            return err("Missing org_id / start_date / end_date", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const exportRes = await fetch(
            `${SUPA_URL}/functions/v1/export-messages`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${INTERNAL_SECRET ?? SUPA_SERVICE_KEY}`,
              },
              body: JSON.stringify({ org_id, start_date, end_date, recipient_email }),
            }
          );
          const payload = await exportRes.json();
          if (!exportRes.ok) {
            return err(payload.error || "Export failed", exportRes.status);
          }
          return ok(payload);
        }

        // ── Message export: list available recipients for the picker ────────
        case "list_export_recipients": {
          const { org_id } = body as { org_id: string };
          if (!org_id) return err("Missing org_id", 400);
          await assertOrgAccess(adminClient, dashUser, org_id);

          const [{ data: provider }, { data: recips }] = await Promise.all([
            adminClient
              .schema("comms").from("email_providers")
              .select("provider_account_email")
              .eq("organization_id", org_id)
              .eq("status", "active")
              .maybeSingle(),
            adminClient
              .schema("comms").from("notification_recipients")
              .select("id, name, email, notify_on")
              .eq("organization_id", org_id)
              .eq("is_active", true)
              .order("created_at", { ascending: true }),
          ]);

          return ok({
            default_email: provider?.provider_account_email ?? null,
            notification_recipients: recips ?? [],
          });
        }

        // ── Message export: list scheduled exports ──────────────────────────
        case "list_export_schedules": {
          const { org_id } = body as { org_id: string };
          if (!org_id) return err("Missing org_id", 400);
          await assertOrgAccess(adminClient, dashUser, org_id);

          const { data, error } = await adminClient
            .schema("comms").from("export_schedules")
            .select("*")
            .eq("organization_id", org_id)
            .order("created_at", { ascending: false });
          if (error) throw error;
          return ok({ schedules: data ?? [] });
        }

        // ── Message export: create scheduled export ─────────────────────────
        case "create_export_schedule": {
          const { org_id, frequency, recipient_email } = body as {
            org_id: string;
            frequency: "daily" | "weekly" | "monthly" | "quarterly";
            recipient_email: string;
          };
          if (!org_id || !frequency || !recipient_email) {
            return err("Missing org_id / frequency / recipient_email", 400);
          }
          if (!["daily", "weekly", "monthly", "quarterly"].includes(frequency)) {
            return err("Invalid frequency", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const next_run_at = computeNextRunAt(frequency, new Date()).toISOString();
          const { data, error } = await adminClient
            .schema("comms").from("export_schedules")
            .insert({
              organization_id: org_id,
              frequency,
              recipient_email,
              next_run_at,
              created_by: dashUser.id,
            })
            .select()
            .single();
          if (error) throw error;
          return ok({ schedule: data });
        }

        // ── Message export: update scheduled export ─────────────────────────
        case "update_export_schedule": {
          const { schedule_id, frequency, recipient_email, is_active } = body as {
            schedule_id: string;
            frequency?: "daily" | "weekly" | "monthly" | "quarterly";
            recipient_email?: string;
            is_active?: boolean;
          };
          if (!schedule_id) return err("Missing schedule_id", 400);

          const { data: existing, error: fetchErr } = await adminClient
            .schema("comms").from("export_schedules")
            .select("organization_id, frequency")
            .eq("id", schedule_id)
            .single();
          if (fetchErr || !existing) return err("Schedule not found", 404);

          await assertOrgAccess(adminClient, dashUser, existing.organization_id);

          const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
          if (typeof recipient_email === "string") updates.recipient_email = recipient_email;
          if (typeof is_active === "boolean") updates.is_active = is_active;
          if (typeof frequency === "string") {
            if (!["daily", "weekly", "monthly", "quarterly"].includes(frequency)) {
              return err("Invalid frequency", 400);
            }
            updates.frequency = frequency;
            if (frequency !== existing.frequency) {
              updates.next_run_at = computeNextRunAt(frequency, new Date()).toISOString();
            }
          }

          const { data, error } = await adminClient
            .schema("comms").from("export_schedules")
            .update(updates)
            .eq("id", schedule_id)
            .select()
            .single();
          if (error) throw error;
          return ok({ schedule: data });
        }

        // ── Message export: delete scheduled export ─────────────────────────
        case "delete_export_schedule": {
          const { schedule_id } = body as { schedule_id: string };
          if (!schedule_id) return err("Missing schedule_id", 400);

          const { data: existing, error: fetchErr } = await adminClient
            .schema("comms").from("export_schedules")
            .select("organization_id")
            .eq("id", schedule_id)
            .single();
          if (fetchErr || !existing) return err("Schedule not found", 404);

          await assertOrgAccess(adminClient, dashUser, existing.organization_id);

          const { error } = await adminClient
            .schema("comms").from("export_schedules")
            .delete()
            .eq("id", schedule_id);
          if (error) throw error;
          return ok({ success: true });
        }

        // ── Emergency: disable ALL orgs ─────────────────────────────────────
        case "emergency_disable_all": {
          if (!isOwner) return err("Only owners can use the emergency kill switch", 403);

          const { error: wErr } = await adminClient
            .schema("core").from("widget_configs")
            .update({ enabled: false, disable_reason: "emergency", disable_message: "Service temporarily suspended." })
            .eq("enabled", true);

          if (wErr) throw wErr;

          const { error: aiErr } = await adminClient
            .schema("core").from("organizations")
            .update({ ai_responses_enabled: false })
            .eq("ai_responses_enabled", true);

          if (aiErr) throw aiErr;

          const { error: asErr } = await adminClient
            .schema("core").from("organizations")
            .update({ auto_send_enabled: false })
            .eq("auto_send_enabled", true);

          if (asErr) throw asErr;

          return ok({ success: true });
        }

        // ── Emergency: restore previously enabled orgs ──────────────────────
        case "emergency_restore": {
          if (!isOwner) return err("Only owners can restore from emergency", 403);

          const { error: wErr } = await adminClient
            .schema("core").from("widget_configs")
            .update({ enabled: true, disable_reason: null, disable_message: null })
            .eq("disable_reason", "emergency");

          if (wErr) throw wErr;

          const { error: aiErr } = await adminClient
            .schema("core").from("organizations")
            .update({ ai_responses_enabled: true, auto_send_enabled: true })
            .eq("ai_responses_enabled", false);

          if (aiErr) throw aiErr;

          return ok({ success: true });
        }

        // ── List demo organizations ────────────────────────────────────────
        case "list_demos": {
          const { data, error } = await adminClient
            .schema("core").from("organizations")
            .select(`
              id, name, slug, subscription_tier,
              messages_used_this_month, message_limit_per_month,
              ai_tone, ai_responses_enabled
            `)
            .eq("is_demo", true)
            .order("name", { ascending: true });

          if (error) throw error;

          const orgIds = (data || []).map(o => o.id);
          if (orgIds.length === 0) return ok({ demos: [], widgets: [] });

          const { data: widgets } = await adminClient
            .schema("core").from("widget_configs")
            .select("organization_id, enabled, api_key")
            .in("organization_id", orgIds);

          return ok({ demos: data, widgets: widgets || [] });
        }

        // ── Create demo organization (owner only) ──────────────────────────
        case "create_demo": {
          if (!isOwner) return err("Only owners can create demos", 403);

          const { name, slug, ai_tone, message_limit_per_month, auto_send_min_confidence, subscription_tier } = body;
          if (!name || !slug) return err("Missing name or slug", 400);

          const demoLimit = (message_limit_per_month as number) ?? 7500;
          const demoBillingDay = Math.min(new Date().getUTCDate(), 28);

          const { data: org, error: orgErr } = await adminClient
            .schema("core").from("organizations")
            .insert({
              name, slug,
              ai_tone: ai_tone || "professional",
              message_limit_per_month: demoLimit,
              monthly_credits_remaining: demoLimit,
              billing_day_of_month: demoBillingDay,
              auto_send_min_confidence: auto_send_min_confidence || 0.75,
              subscription_tier: subscription_tier || "basic",
              auto_send_enabled: true,
              ai_responses_enabled: true,
              is_demo: true,
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select()
            .single();

          if (orgErr) throw orgErr;

          // Auto-create widget config (enabled for demos)
          await adminClient.schema("core").from("widget_configs").insert({
            organization_id: org.id,
            enabled: true,
          });

          // Create initial demo_defaults snapshot
          await adminClient.schema("core").from("demo_defaults").insert({
            organization_id: org.id,
            name: org.name,
            slug: org.slug,
            ai_tone: org.ai_tone,
            ai_system_prompt: org.ai_system_prompt,
            auto_send_min_confidence: org.auto_send_min_confidence,
            auto_send_enabled: org.auto_send_enabled,
            ai_responses_enabled: org.ai_responses_enabled,
            subscription_tier: org.subscription_tier,
            message_limit_per_month: org.message_limit_per_month,
            widget_defaults: null,
            kb_defaults: [],
          });

          return ok({ org });
        }

        // ── Reset demo to defaults ─────────────────────────────────────────
        case "reset_demo": {
          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          await assertOrgAccess(adminClient, dashUser, org_id as string);

          // Verify it's a demo org
          const { data: org } = await adminClient
            .schema("core").from("organizations")
            .select("is_demo")
            .eq("id", org_id)
            .single();

          if (!org?.is_demo) return err("Not a demo organization", 400);

          // Fetch defaults
          const { data: defaults, error: defErr } = await adminClient
            .schema("core").from("demo_defaults")
            .select("*")
            .eq("organization_id", org_id)
            .single();

          if (defErr || !defaults) return err("No defaults found for this demo", 404);

          // 1. Reset organization settings
          const { error: orgErr } = await adminClient
            .schema("core").from("organizations")
            .update({
              name: defaults.name,
              slug: defaults.slug,
              ai_tone: defaults.ai_tone,
              ai_system_prompt: defaults.ai_system_prompt,
              auto_send_min_confidence: defaults.auto_send_min_confidence,
              auto_send_enabled: defaults.auto_send_enabled,
              ai_responses_enabled: defaults.ai_responses_enabled,
              subscription_tier: defaults.subscription_tier,
              message_limit_per_month: defaults.message_limit_per_month,
              messages_used_this_month: 0,
              limit_exceeded_at: null,
              limit_notified_at: null,
            })
            .eq("id", org_id);

          if (orgErr) throw orgErr;

          // 2. Reset widget config
          if (defaults.widget_defaults) {
            const { error: wErr } = await adminClient
              .schema("core").from("widget_configs")
              .update(defaults.widget_defaults)
              .eq("organization_id", org_id);
            if (wErr) throw wErr;
          }

          // 3. Reset KB: demo orgs get a fresh v1 from defaults (versioned KB)
          await adminClient.schema("kb").from("kb_versions").delete().eq("organization_id", org_id);
          await adminClient.schema("core").from("organizations")
            .update({ active_kb_version_id: null }).eq("id", org_id);
          // (legacy kb_chunks/kb_documents tables were dropped after the
          // versioned-KB migration — nothing to clean up there)

          const kbDefaultsRaw = defaults.kb_defaults as unknown;
          if (kbDefaultsRaw && !Array.isArray(kbDefaultsRaw) && Array.isArray((kbDefaultsRaw as { sections?: unknown }).sections)) {
            // New format: { sections } → insert v1 directly
            const sections = (kbDefaultsRaw as { sections: unknown[] }).sections;
            if (sections.length > 0) {
              const { data: v1 } = await adminClient
                .schema("kb").from("kb_versions")
                .insert({
                  organization_id: org_id,
                  version: 1,
                  sections,
                  change_summary: "Reset to demo defaults",
                  source: "template",
                })
                .select("id")
                .single();
              if (v1) {
                await adminClient.schema("core").from("organizations")
                  .update({ active_kb_version_id: v1.id }).eq("id", org_id);
              }
            }
          } else {
            // Legacy format: array of {title, format, content} → append via kb-ingest
            const kbDefaults = (kbDefaultsRaw as Array<{ title: string; format: string; content: unknown }>) || [];
            for (const doc of kbDefaults) {
              const res = await fetch(`${SUPA_URL}/functions/v1/kb-ingest`, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${SUPA_SERVICE_KEY}`,
                  "x-internal-secret": Deno.env.get("INTERNAL_API_SECRET") ?? "",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  organization_id: org_id,
                  title: doc.title,
                  format: doc.format,
                  content: doc.content,
                  source: "template",
                  change_summary: "Reset to demo defaults",
                }),
              });
              if (!res.ok) {
                const txt = await res.text();
                console.error(`reset_demo: kb-ingest failed for ${doc.title}:`, txt);
              }
            }
          }

          return ok({ success: true });
        }

        // ── Save demo defaults (owner only) ─────────────────────────────────
        case "save_demo_defaults": {
          if (!isOwner) return err("Only owners can save demo defaults", 403);

          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          // Fetch current org state
          const { data: org } = await adminClient
            .schema("core").from("organizations")
            .select("*")
            .eq("id", org_id)
            .single();

          if (!org?.is_demo) return err("Not a demo organization", 400);

          // Fetch current widget config
          const { data: widget } = await adminClient
            .schema("core").from("widget_configs")
            .select("*")
            .eq("organization_id", org_id)
            .maybeSingle();

          // Snapshot the active KB version's sections (whole-KB model)
          let kbDefaults: unknown = { sections: [] };
          if (org.active_kb_version_id) {
            const { data: activeVersion } = await adminClient
              .schema("kb").from("kb_versions")
              .select("sections")
              .eq("id", org.active_kb_version_id)
              .single();
            kbDefaults = { sections: (activeVersion?.sections as unknown) || [] };
          }

          // Strip widget fields that shouldn't be in defaults
          let widgetDefaults = null;
          if (widget) {
            const { id, organization_id, api_key, created_at, updated_at, ...rest } = widget;
            widgetDefaults = rest;
          }

          // Upsert into demo_defaults
          const { error } = await adminClient
            .schema("core").from("demo_defaults")
            .upsert({
              organization_id: org_id,
              name: org.name,
              slug: org.slug,
              ai_tone: org.ai_tone,
              ai_system_prompt: org.ai_system_prompt,
              auto_send_min_confidence: org.auto_send_min_confidence,
              auto_send_enabled: org.auto_send_enabled,
              ai_responses_enabled: org.ai_responses_enabled,
              subscription_tier: org.subscription_tier,
              message_limit_per_month: org.message_limit_per_month,
              widget_defaults: widgetDefaults,
              kb_defaults: kbDefaults,
              updated_at: new Date().toISOString(),
            }, { onConflict: "organization_id" });

          if (error) throw error;
          return ok({ success: true });
        }

        // ── Delete demo organization (owner only) ──────────────────────────
        case "delete_demo": {
          if (!isOwner) return err("Only owners can delete demos", 403);

          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);

          // Verify it's actually a demo before doing anything destructive
          const { data: org, error: lookupErr } = await adminClient
            .schema("core").from("organizations")
            .select("id, is_demo")
            .eq("id", org_id)
            .single();
          if (lookupErr || !org) return err("Demo not found", 404);
          if (!org.is_demo) {
            return err("Refusing to delete a non-demo organization via delete_demo", 400);
          }

          // Delete child rows in dependency order. FK ON DELETE behavior is
          // not guaranteed across the schema, so we delete defensively.
          // Per-table errors are logged and skipped — most demos
          // won't have rows in most of these tables.
          const childTables = [
            "kb_versions",
            "kb_amend_requests",
            "demo_defaults",
            "widget_surveys",
            "widget_configs",
            "notification_recipients",
            "delivery_queue",
            "rate_limit_buckets",
            "messages",
            "conversation_merges",
            "conversations",
            "contact_aliases",
            "contacts",
            "export_schedules",
            "payment_history",
            "audit_logs",
            "analytics_events",
            "analytics_hourly",
            "analytics_daily",
            "business_hours",
            "business_services",
            "business_staff",
            "business_profiles",
            "integrations",
            "email_providers",
            "organization_members",
          ];
          for (const t of childTables) {
            const { error: childErr } = await adminClient
              .schema(TABLE_SCHEMA[t])
              .from(t)
              .delete()
              .eq("organization_id", org_id as string);
            if (childErr) console.error(`delete_demo: failed to clear ${t}:`, childErr.message);
          }

          // Final delete with belt-and-braces is_demo guard
          const { error: delErr } = await adminClient
            .schema("core").from("organizations")
            .delete()
            .eq("id", org_id as string)
            .eq("is_demo", true);
          if (delErr) throw delErr;

          return ok({ success: true });
        }

        // ── Delete real organization (owner only, typed confirmation) ──────
        case "delete_org": {
          if (!isOwner) return err("Only owners can delete organizations", 403);

          const { org_id, confirm_slug } = body as { org_id?: string; confirm_slug?: string };
          if (!org_id) return err("Missing org_id", 400);
          if (!confirm_slug) return err("Missing confirm_slug", 400);

          // Look up the org and verify slug matches — prevents accidental
          // deletion by an operator who clicked the wrong row.
          const { data: org, error: lookupErr } = await adminClient
            .schema("core").from("organizations")
            .select("id, slug, is_demo")
            .eq("id", org_id)
            .single();
          if (lookupErr || !org) return err("Organization not found", 404);
          if (org.slug !== confirm_slug) {
            return err("confirm_slug does not match organization slug", 400);
          }
          if (org.is_demo) {
            return err("Use delete_demo for demo organizations", 400);
          }

          // Same defensive child-table cleanup as delete_demo. Per-table
          // errors are logged and skipped — most orgs won't have rows in
          // every table.
          const childTables = [
            "kb_versions",
            "kb_amend_requests",
            "demo_defaults",
            "widget_surveys",
            "widget_configs",
            "notification_recipients",
            "delivery_queue",
            "rate_limit_buckets",
            "messages",
            "conversation_merges",
            "conversations",
            "contact_aliases",
            "contacts",
            "export_schedules",
            "payment_history",
            "audit_logs",
            "analytics_events",
            "analytics_hourly",
            "analytics_daily",
            "business_hours",
            "business_services",
            "business_staff",
            "business_profiles",
            "integrations",
            "email_providers",
            "organization_members",
          ];
          for (const t of childTables) {
            const { error: childErr } = await adminClient
              .schema(TABLE_SCHEMA[t])
              .from(t)
              .delete()
              .eq("organization_id", org_id as string);
            if (childErr) console.error(`delete_org: failed to clear ${t}:`, childErr.message);
          }

          // Final delete with is_demo=false guard so this action can never
          // bypass the delete_demo safety path.
          const { error: delErr } = await adminClient
            .schema("core").from("organizations")
            .delete()
            .eq("id", org_id as string)
            .eq("is_demo", false);
          if (delErr) throw delErr;

          return ok({ success: true });
        }

        // ── Use demo template on a regular org ──────────────────────────────
        case "use_demo_template": {
          const { demo_org_id, target_org_id, copy_kb, copy_prompt, copy_widget, copy_tone } = body as {
            demo_org_id: string;
            target_org_id: string;
            copy_kb?: boolean;
            copy_prompt?: boolean;
            copy_widget?: boolean;
            copy_tone?: boolean;
          };

          if (!demo_org_id || !target_org_id) return err("Missing demo_org_id or target_org_id", 400);

          // Verify access to target org
          await assertOrgAccess(adminClient, dashUser, target_org_id);

          // Read the demo's LIVE state rather than the demo_defaults snapshot,
          // so templates always reflect the demo as it currently exists.
          const { data: demoOrg, error: demoOrgErr } = await adminClient
            .schema("core").from("organizations")
            .select("is_demo, ai_system_prompt, ai_tone")
            .eq("id", demo_org_id)
            .single();

          if (demoOrgErr || !demoOrg) return err("Demo organization not found", 404);
          if (!demoOrg.is_demo) return err("Source organization is not a demo", 400);

          // Copy system prompt
          if (copy_prompt && demoOrg.ai_system_prompt) {
            await adminClient
              .schema("core").from("organizations")
              .update({ ai_system_prompt: demoOrg.ai_system_prompt })
              .eq("id", target_org_id);
          }

          // Copy AI tone
          if (copy_tone && demoOrg.ai_tone) {
            await adminClient
              .schema("core").from("organizations")
              .update({ ai_tone: demoOrg.ai_tone })
              .eq("id", target_org_id);
          }

          // Copy widget settings (colors, appearance — not api_key, enabled status)
          if (copy_widget) {
            const { data: demoWidget } = await adminClient
              .schema("core").from("widget_configs")
              .select("*")
              .eq("organization_id", demo_org_id)
              .maybeSingle();

            if (demoWidget) {
              const {
                id: _id,
                organization_id: _orgId,
                api_key: _apiKey,
                created_at: _createdAt,
                updated_at: _updatedAt,
                enabled: _enabled,
                disable_reason: _disableReason,
                disable_message: _disableMessage,
                ...safeWidgetUpdates
              } = demoWidget;
              await adminClient
                .schema("core").from("widget_configs")
                .update(safeWidgetUpdates)
                .eq("organization_id", target_org_id);
            }
          }

          // Copy KB (additive — appended as a new version on the target).
          if (copy_kb) {
            const { data: demoOrg } = await adminClient
              .schema("core").from("organizations")
              .select("active_kb_version_id")
              .eq("id", demo_org_id)
              .single();

            if (demoOrg?.active_kb_version_id) {
              const { data: demoVersion } = await adminClient
                .schema("kb").from("kb_versions")
                .select("sections")
                .eq("id", demoOrg.active_kb_version_id)
                .single();

              const demoSections = (demoVersion?.sections as unknown[]) || [];
              if (demoSections.length > 0) {
                // Current target sections (if any)
                let targetSections: unknown[] = [];
                const { data: targetOrg } = await adminClient
                  .schema("core").from("organizations")
                  .select("active_kb_version_id")
                  .eq("id", target_org_id)
                  .single();
                if (targetOrg?.active_kb_version_id) {
                  const { data: targetVersion } = await adminClient
                    .schema("kb").from("kb_versions")
                    .select("sections")
                    .eq("id", targetOrg.active_kb_version_id)
                    .single();
                  targetSections = (targetVersion?.sections as unknown[]) || [];
                }

                const { data: maxRow } = await adminClient
                  .schema("kb").from("kb_versions")
                  .select("version")
                  .eq("organization_id", target_org_id)
                  .order("version", { ascending: false })
                  .limit(1)
                  .maybeSingle();

                const { data: newVersion } = await adminClient
                  .schema("kb").from("kb_versions")
                  .insert({
                    organization_id: target_org_id,
                    version: (maxRow?.version ?? 0) + 1,
                    sections: [...targetSections, ...demoSections],
                    change_summary: "Copied KB from demo template",
                    source: "template",
                    created_by: dashUser.id,
                    created_by_name: dashUser.display_name,
                  })
                  .select("id")
                  .single();

                if (newVersion) {
                  await adminClient.schema("core").from("organizations")
                    .update({ active_kb_version_id: newVersion.id })
                    .eq("id", target_org_id);
                }
              }
            }
          }

          return ok({ success: true });
        }

        // ── PayPal: create order (server-side) ──────────────────────────────
        case "paypal_create_order": {
          const { org_id, amount, description, category } = body as {
            org_id: string; amount: number; description: string; category: string;
          };
          if (!org_id || !amount || !description || !category) {
            return err("Missing org_id, amount, description, or category", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const allowed = isOwner ? OWNER_PRESETS : SALESPERSON_PRESETS;
          if (!allowed.has(category)) {
            return err(`Category "${category}" is not permitted for your role`, 403);
          }

          const trace = crypto.randomUUID().slice(0, 8);
          paypalLog("action.paypal_create_order", {
            trace, org_id, user_id: dashUser.id, amount, category,
          });
          const order = await paypalCreateOrder(Number(amount), description, trace);
          return ok({ id: order.id });
        }

        // ── PayPal: capture order (server-side) ─────────────────────────────
        case "paypal_capture_order": {
          const { org_id, order_id, category, amount, description } = body as {
            org_id: string; order_id: string; category: string;
            amount: number; description: string;
          };
          if (!org_id || !order_id || !category || !amount || !description) {
            return err("Missing required fields", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const allowed = isOwner ? OWNER_PRESETS : SALESPERSON_PRESETS;
          if (!allowed.has(category)) {
            return err(`Category "${category}" is not permitted for your role`, 403);
          }

          const trace = crypto.randomUUID().slice(0, 8);
          paypalLog("action.paypal_capture_order", {
            trace, org_id, user_id: dashUser.id, order_id, amount, category,
          });
          const capture = await paypalCaptureOrder(order_id, trace);
          if (capture.status !== "COMPLETED") {
            paypalLog("capture.not_completed", {
              trace, order_id, paypal_status: capture.status,
            });
            await adminClient.schema("billing").from("payment_history").insert({
              organization_id: org_id,
              amount: Number(amount),
              description,
              category,
              paypal_order_id: order_id,
              paypal_capture_id: capture.captureId,
              payer_email: capture.payerEmail,
              status: "failed",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            });
            return err(`PayPal capture status: ${capture.status}`, 502);
          }

          let creditsAdded: number | null = null;

          // Apply side-effects per category
          if (category === "monthly" || category === "yearly") {
            const result = await extendSubscription(adminClient, org_id, category);
            if (!result.ok) return err(result.error!, result.status!);
          } else if (category === "addon") {
            const { data: orgRow, error: orgErr } = await adminClient
              .schema("core").from("organizations")
              .select("addon_credits")
              .eq("id", org_id)
              .single();
            if (orgErr) throw orgErr;
            creditsAdded = ADDON_CREDITS;
            await adminClient
              .schema("core").from("organizations")
              .update({ addon_credits: (orgRow?.addon_credits ?? 0) + ADDON_CREDITS })
              .eq("id", org_id);
            // Re-enable widget if it was disabled due to usage limit — addon credits restore service
            await adminClient
              .schema("core").from("widget_configs")
              .update({ enabled: true, disable_reason: null, disable_message: null })
              .eq("organization_id", org_id)
              .eq("disable_reason", "usage_limit");
            await adminClient
              .schema("core").from("organizations")
              .update({ limit_exceeded_at: null, limit_notified_at: null })
              .eq("id", org_id);
          }

          const { data: row, error: insErr } = await adminClient
            .schema("billing").from("payment_history")
            .insert({
              organization_id: org_id,
              amount: Number(amount),
              description,
              category,
              paypal_order_id: order_id,
              paypal_capture_id: capture.captureId,
              payer_email: capture.payerEmail,
              status: "completed",
              credits_added: creditsAdded,
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select()
            .single();
          if (insErr) throw insErr;

          paypalLog("action.paypal_capture_order.completed", {
            trace, org_id, order_id, payment_id: row.id, credits_added: creditsAdded,
          });

          // ── Send payment confirmation email ───────────────────────────────
          try {
            const { data: orgForEmail } = await adminClient
              .schema("core").from("organizations")
              .select("name, subscription_end_date")
              .eq("id", org_id)
              .single();
            const orgName = orgForEmail?.name ?? "your organization";
            const dollar = Number(amount).toLocaleString("en-US", {
              minimumFractionDigits: 2, maximumFractionDigits: 2,
            });

            if (category === "setup") {
              // Setup fee — standalone confirmation
              const subject = `Payment received — setup fee for ${orgName}`;
              const emailBody = [
                `Hi,`,
                ``,
                `We've received your setup fee payment of $${dollar} for ${orgName}.`,
                ``,
                `Your account is being configured and you'll be notified once everything is ready.`,
                ``,
                `Thank you for choosing Thoth Line!`,
                `Thoth Line`,
              ].join("\n");
              await sendOrgNotification(adminClient, org_id, "system", subject, emailBody);
            } else if (category === "monthly" || category === "yearly" || category === "addon") {
              // Subscription / addon — combined payment + renewal confirmation
              const planLabel = category === "yearly" ? "yearly plan"
                : category === "addon" ? "message credit add-on"
                : "monthly plan";
              const endDateStr = orgForEmail?.subscription_end_date
                ? new Date(orgForEmail.subscription_end_date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
                : null;
              const subject = `Payment received — ${planLabel} for ${orgName}`;
              const emailBody = [
                `Hi,`,
                ``,
                `We've received your payment of $${dollar} for the ${planLabel} for ${orgName}.`,
                ``,
                category === "addon"
                  ? `${ADDON_CREDITS.toLocaleString()} message credits have been added to your account.`
                  : endDateStr
                    ? `Your service is now active until ${endDateStr}.`
                    : `Your subscription has been renewed.`,
                ``,
                `Thank you for your continued trust in Thoth Line!`,
                `Thoth Line`,
              ].join("\n");
              await sendOrgNotification(adminClient, org_id, "system", subject, emailBody);
            }
          } catch (emailErr) {
            console.error("Failed to send payment confirmation email:", (emailErr as Error).message);
          }

          return ok({
            success: true,
            payment: row,
            capture_id: capture.captureId,
            payer_email: capture.payerEmail,
          });
        }

        // ── PayPal: create order + return approve link ──────────────────────
        case "paypal_create_link": {
          const { org_id, amount, description, category } = body as {
            org_id: string; amount: number; description: string; category: string;
          };
          if (!org_id || !amount || !description || !category) {
            return err("Missing org_id, amount, description, or category", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const allowed = isOwner ? OWNER_PRESETS : SALESPERSON_PRESETS;
          if (!allowed.has(category)) {
            return err(`Category "${category}" is not permitted for your role`, 403);
          }

          const trace = crypto.randomUUID().slice(0, 8);
          paypalLog("action.paypal_create_link", {
            trace, org_id, user_id: dashUser.id, amount, category,
          });
          const order = await paypalCreateOrder(Number(amount), description, trace);
          if (!order.approveUrl) {
            paypalLog("create_link.no_approve_url", { trace, order_id: order.id });
            return err("PayPal did not return an approval link", 502);
          }

          const { data: row, error: insErr } = await adminClient
            .schema("billing").from("payment_history")
            .insert({
              organization_id: org_id,
              amount: Number(amount),
              description,
              category,
              paypal_order_id: order.id,
              status: "pending_link",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select()
            .single();
          if (insErr) throw insErr;

          paypalLog("action.paypal_create_link.ok", {
            trace, org_id, order_id: order.id, payment_id: row.id,
          });
          return ok({ approve_url: order.approveUrl, order_id: order.id, payment_id: row.id });
        }

        // ── Create a dashboard invoice (no PayPal order yet) ────────────────
        // The customer pays this from their /payments page in the customer
        // dashboard, which creates the PayPal order at that point.
        case "create_dashboard_invoice": {
          const { org_id, amount, description, category } = body as {
            org_id: string; amount: number; description: string; category: string;
          };
          if (!org_id || !amount || !description || !category) {
            return err("Missing org_id, amount, description, or category", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const allowed = isOwner ? OWNER_PRESETS : SALESPERSON_PRESETS;
          if (!allowed.has(category)) {
            return err(`Category "${category}" is not permitted for your role`, 403);
          }

          const { data: row, error: insErr } = await adminClient
            .schema("billing").from("payment_history")
            .insert({
              organization_id: org_id,
              amount: Number(amount),
              description,
              category,
              status: "awaiting_payment",
              created_by: dashUser.id,
              created_by_name: dashUser.display_name,
            })
            .select()
            .single();
          if (insErr) throw insErr;

          return ok({ success: true, payment: row });
        }

        // ── Send a payment link to system-alert recipients ──────────────────
        case "send_payment_link": {
          const { org_id, approve_url, amount, description } = body as {
            org_id: string; approve_url: string; amount: number; description: string;
          };
          if (!org_id || !approve_url || !amount || !description) {
            return err("Missing required fields", 400);
          }
          await assertOrgAccess(adminClient, dashUser, org_id);

          const { data: orgRow } = await adminClient
            .schema("core").from("organizations")
            .select("name")
            .eq("id", org_id)
            .single();

          const subject = `Payment link from ${orgRow?.name ?? "Thoth Line"}`;
          const dollar = Number(amount).toLocaleString("en-US", {
            minimumFractionDigits: 2, maximumFractionDigits: 2,
          });
          const emailBody = [
            `Hi,`,
            ``,
            `Please use the link below to complete your payment of $${dollar} for: ${description}.`,
            ``,
            approve_url,
            ``,
            `If you have any questions, just reply to this email.`,
            ``,
            `Thank you,`,
            orgRow?.name ?? "Thoth Line",
          ].join("\n");

          const sentTo = await sendOrgNotification(
            adminClient,
            org_id,
            "system",
            subject,
            emailBody
          );

          return ok({ sent_to: sentTo, plaintext_url: approve_url });
        }

        // ── List payments for an org ────────────────────────────────────────
        case "list_payments": {
          const { org_id } = body;
          if (!org_id) return err("Missing org_id", 400);
          await assertOrgAccess(adminClient, dashUser, org_id as string);

          const { data, error } = await adminClient
            .schema("billing").from("payment_history")
            .select("*")
            .eq("organization_id", org_id)
            .order("created_at", { ascending: false });

          if (error) throw error;
          return ok({ payments: data });
        }

        // ── Delete a payment history entry (owner only) ─────────────────────
        case "delete_payment": {
          if (!isOwner) return err("Only owners can delete payment records", 403);

          const { org_id, payment_id } = body as { org_id: string; payment_id: string };
          if (!org_id || !payment_id) return err("Missing org_id or payment_id", 400);

          const { error } = await adminClient
            .schema("billing").from("payment_history")
            .delete()
            .eq("id", payment_id)
            .eq("organization_id", org_id);

          if (error) throw error;
          return ok({ success: true });
        }

        // ── Update a payment history entry (owner only) ─────────────────────
        case "update_payment": {
          if (!isOwner) return err("Only owners can edit payment records", 403);

          const { org_id, payment_id, updates } = body as {
            org_id: string; payment_id: string; updates: Record<string, unknown>;
          };
          if (!org_id || !payment_id || !updates) {
            return err("Missing org_id, payment_id, or updates", 400);
          }

          // Whitelist editable fields — don't let the frontend tamper with PayPal IDs
          const editable: Record<string, unknown> = {};
          for (const key of ["amount", "description", "category", "status", "payer_email", "credits_added"]) {
            if (key in updates) editable[key] = updates[key];
          }

          const { error } = await adminClient
            .schema("billing").from("payment_history")
            .update(editable)
            .eq("id", payment_id)
            .eq("organization_id", org_id);

          if (error) throw error;
          return ok({ success: true });
        }

        default:
          return err(`Unknown action: ${action}`, 400);
      }
    } catch (e) {
      console.error(`dashboard-api error [${action}]:`, e.message);
      return err(e.message, 500);
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async function assertOrgAccess(
    adminClient: ReturnType<typeof createClient>,
    dashUser: DashboardUser,
    orgId: string
  ): Promise<void> {
    if (dashUser.role === "owner") return; // Owners can access all orgs

    // Check if this is a demo org — demos are always accessible to all roles
    const { data: orgCheck } = await adminClient
      .schema("core").from("organizations")
      .select("id, is_demo")
      .eq("id", orgId)
      .single();

    if (!orgCheck) {
      throw new Error("Access denied — organization not found");
    }

    if (orgCheck.is_demo) return; // Demos accessible to all roles, always

    // Salespeople can only access non-demo orgs they created today (US Pacific time)
    const todayStartLocal = getTodayStartUS();

    const { data, error } = await adminClient
      .schema("core").from("organizations")
      .select("id")
      .eq("id", orgId)
      .eq("created_by", dashUser.id)
      .gte("created_at", todayStartLocal)
      .single();

    if (error || !data) {
      throw new Error("Access denied — organization not found or outside your access window");
    }
  }

  // Returns the start of "today" in US Pacific time as an ISO string.
  // Uses Pacific (latest mainland US timezone) so the access window stays
  // open while salespeople in Europe are still calling US customers.
  function getTodayStartUS(): string {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    // en-CA gives YYYY-MM-DD format
    const localDate = formatter.format(now);
    const parts = localDate.split("-");
    const midnightLocal = new Date(
      Date.UTC(+parts[0], +parts[1] - 1, +parts[2])
    );
    // Adjust for Pacific's UTC offset at that midnight moment
    const offsetMs = getTimezoneOffsetMs("America/Los_Angeles", midnightLocal);
    return new Date(midnightLocal.getTime() - offsetMs).toISOString();
  }

  function getTimezoneOffsetMs(tz: string, date: Date): number {
    const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = date.toLocaleString("en-US", { timeZone: tz });
    return new Date(tzStr).getTime() - new Date(utcStr).getTime();
  }

  function ok(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  function err(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // ── Subscription extension (shared by renew_subscription + paypal_capture_order)
  async function extendSubscription(
    adminClient: ReturnType<typeof createClient>,
    orgId: string,
    plan?: string
  ): Promise<{ ok: boolean; newEndDate?: string; error?: string; status?: number }> {
    const { data: currentOrg, error: fetchErr } = await adminClient
      .schema("core").from("organizations")
      .select("subscription_plan, subscription_end_date, billing_day_of_month")
      .eq("id", orgId)
      .single();

    if (fetchErr || !currentOrg) return { ok: false, error: "Org not found", status: 404 };

    const renewPlan = plan === "yearly" ? "yearly"
      : plan === "monthly" ? "monthly"
      : currentOrg.subscription_plan || "monthly";

    const now = new Date();
    const baseDate = currentOrg.subscription_end_date && new Date(currentOrg.subscription_end_date) > now
      ? new Date(currentOrg.subscription_end_date)
      : now;

    // Yearly plan grants 14 months of service (2 bonus months as advertised).
    const newEndDate = renewPlan === "yearly"
      ? addCalendarMonths(baseDate, 14)
      : addCalendarMonths(baseDate, 1);

    const { error: updateErr } = await adminClient
      .schema("core").from("organizations")
      .update({
        subscription_plan: renewPlan,
        subscription_start_date: now.toISOString(),
        subscription_end_date: newEndDate.toISOString(),
        ai_responses_enabled: true,
        grace_period_ends_at: null,
        suspension_warning_sent_at: null,
      })
      .eq("id", orgId);

    if (updateErr) return { ok: false, error: updateErr.message, status: 500 };

    // Mark rollover_eligible=true only if this payment was BOTH in-cycle
    // (before the old subscription_end_date) AND on or before the current
    // cycle's billing day. Late-in-cycle and grace-period catchup payments
    // leave the flag false, forfeiting the unused credits at the next reset.
    if (currentOrg.subscription_end_date) {
      const oldEndDate = new Date(currentOrg.subscription_end_date);
      if (now < oldEndDate) {
        const billingDay = (currentOrg as { billing_day_of_month?: number }).billing_day_of_month || 1;
        let billingDate = new Date(Date.UTC(
          oldEndDate.getUTCFullYear(),
          oldEndDate.getUTCMonth(),
          billingDay
        ));
        if (billingDate >= oldEndDate) {
          billingDate = new Date(Date.UTC(
            oldEndDate.getUTCFullYear(),
            oldEndDate.getUTCMonth() - 1,
            billingDay
          ));
        }
        const billingDeadline = new Date(billingDate);
        billingDeadline.setUTCHours(23, 59, 59, 999);

        if (now <= billingDeadline) {
          await adminClient
            .schema("core").from("organizations")
            .update({ rollover_eligible: true })
            .eq("id", orgId);
        }
      }
    }

    await adminClient
      .schema("core").from("widget_configs")
      .update({ enabled: true, disable_reason: null, disable_message: null })
      .eq("organization_id", orgId)
      .eq("disable_reason", "subscription_expired");

    return { ok: true, newEndDate: newEndDate.toISOString() };
  }

  // ── PayPal client (server-side) ──────────────────────────────────────────────
  // Structured logging — every PayPal call emits one or more `[paypal]` lines that
  // can be grepped out of Supabase Edge Function logs. The `env` field makes it
  // instantly obvious whether traffic is going to sandbox or live (this has bitten
  // us before — see incident notes). `trace` correlates log lines from the same
  // request. Never log secrets, tokens, or full card data.
  const PAYPAL_ENV: "sandbox" | "live" = PAYPAL_BASE.includes("sandbox") ? "sandbox" : "live";

  function paypalLog(event: string, fields: Record<string, unknown>): void {
    console.log("[paypal] " + JSON.stringify({
      ts: new Date().toISOString(),
      env: PAYPAL_ENV,
      event,
      ...fields,
    }));
  }

  async function paypalToken(trace: string): Promise<string> {
    const id = Deno.env.get("PAYPAL_CLIENT_ID");
    const secret = Deno.env.get("PAYPAL_CLIENT_SECRET");
    if (!id || !secret) {
      paypalLog("token.config_missing", { trace, has_id: !!id, has_secret: !!secret });
      throw new Error("PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET not configured");
    }
    // Log a fingerprint of the client ID, not the value itself, so we can tell
    // if a sandbox key is being used against the live base (or vice versa).
    paypalLog("token.request", { trace, base: PAYPAL_BASE, client_id_prefix: id.slice(0, 6) });

    const auth = btoa(`${id}:${secret}`);
    const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      const t = await res.text();
      paypalLog("token.http_error", { trace, status: res.status, body: t.slice(0, 500) });
      throw new Error(`PayPal token error: ${res.status} ${t}`);
    }
    const data = await res.json();
    paypalLog("token.ok", { trace });
    return data.access_token as string;
  }

  async function paypalCreateOrder(
    amount: number,
    description: string,
    trace: string
  ): Promise<{ id: string; approveUrl: string | null }> {
    paypalLog("create_order.start", { trace, amount, description: description.slice(0, 80) });
    const token = await paypalToken(trace);
    const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: { currency_code: "USD", value: amount.toFixed(2) },
          description: description.slice(0, 127),
        }],
        // Modern REST equivalent of the legacy SetExpressCheckout `SOLUTIONTYPE=Sole`
        // flag — show the card-entry form first instead of the PayPal login page,
        // skip shipping (this is a service, not a physical good), and label the
        // confirmation button "Pay Now" so the customer knows clicking it captures.
        // NOTE: `landing_page: "BILLING"` is silently ignored unless "PayPal Account
        // Optional" is also enabled in the merchant account's Website Preferences.
        application_context: {
          brand_name: "Thoth Line",
          landing_page: "BILLING",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      paypalLog("create_order.http_error", {
        trace, status: res.status, amount, body: t.slice(0, 1000),
      });
      throw new Error(`PayPal create order error: ${res.status} ${t}`);
    }
    const data = await res.json();
    const link = (data.links as Array<{ rel: string; href: string }>)?.find(
      (l) => l.rel === "payer-action" || l.rel === "approve"
    );
    paypalLog("create_order.ok", {
      trace,
      order_id: data.id,
      status: data.status,
      has_approve_url: !!link?.href,
      // Logging the approve URL host (not the full URL with token) confirms which
      // PayPal environment the customer will land on without leaking the order token.
      approve_host: link?.href ? new URL(link.href).host : null,
    });
    return { id: data.id as string, approveUrl: link?.href ?? null };
  }

  async function paypalCaptureOrder(
    orderId: string,
    trace: string
  ): Promise<{ status: string; captureId: string | null; payerEmail: string | null }> {
    paypalLog("capture.start", { trace, order_id: orderId });
    const token = await paypalToken(trace);
    const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const t = await res.text();
      paypalLog("capture.http_error", {
        trace, order_id: orderId, status: res.status, body: t.slice(0, 1000),
      });
      throw new Error(`PayPal capture error: ${res.status} ${t}`);
    }
    const data = await res.json();
    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    paypalLog("capture.ok", {
      trace,
      order_id: orderId,
      paypal_status: data.status,
      capture_id: capture?.id ?? null,
      capture_status: capture?.status ?? null,
      has_payer_email: !!data.payer?.email_address,
    });
    return {
      status: data.status as string,
      captureId: capture?.id ?? null,
      payerEmail: data.payer?.email_address ?? null,
    };
  }

  // ── Org notification sender (ported from handle-inbound-email/index.ts) ─────
  // Sends an email to all active notification_recipients matching the event type.
  // Falls back to the connected provider inbox if no recipients are configured.
  // Returns the list of addresses the email was sent to.
  async function sendOrgNotification(
    supabase: ReturnType<typeof createClient>,
    organizationId: string,
    eventType: "escalation" | "usage_limit" | "system",
    subject: string,
    body: string
  ): Promise<string[]> {
    const { data: provider } = await supabase
      .schema("comms").from("email_providers")
      .select("id, provider, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .maybeSingle();

    if (!provider) {
      console.warn(`No active provider for org ${organizationId} — cannot send ${eventType} notification`);
      return [];
    }

    const { data: recipients } = await supabase
      .schema("comms").from("notification_recipients")
      .select("email, name")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .contains("notify_on", [eventType]);

    const toAddresses: string[] = (recipients && recipients.length > 0)
      ? recipients.map((r: { email: string; name: string | null }) =>
          r.name ? `${r.name} <${r.email}>` : r.email)
      : [provider.provider_account_email];

    const accessToken = await getNotificationAccessToken(provider);
    if (!accessToken) return [];

    const sentTo: string[] = [];
    for (const toAddress of toAddresses) {
      try {
        if (provider.provider === "google") {
          const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
          const rawEmail = [
            `From: ${provider.provider_account_email}`,
            `To: ${toAddress}`,
            `Subject: ${encodedSubject}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset=utf-8`,
            ``,
            body,
          ].join("\r\n");

          const encodedEmail = btoa(unescape(encodeURIComponent(rawEmail)))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

          const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw: encodedEmail }),
          });
          if (res.ok) sentTo.push(toAddress);
          else console.error(`Gmail send failed for ${toAddress}: ${await res.text()}`);
        } else if (provider.provider === "microsoft") {
          const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                subject,
                body: { contentType: "Text", content: body },
                toRecipients: [{ emailAddress: { address: toAddress.replace(/.*<(.+)>/, "$1") } }],
              },
              saveToSentItems: false,
            }),
          });
          if (res.ok) sentTo.push(toAddress);
          else console.error(`Graph send failed for ${toAddress}: ${await res.text()}`);
        }
      } catch (e) {
        console.error(`Failed to send ${eventType} notification to ${toAddress}:`, e);
      }
    }
    return sentTo;
  }

  async function getNotificationAccessToken(
    provider: Record<string, unknown>
  ): Promise<string | null> {
    try {
      const { crypto: cryptoMod } = await import("https://deno.land/std@0.177.0/crypto/mod.ts");
      const enc = new TextEncoder();
      const dec = new TextDecoder();

      async function getKey(secret: string): Promise<CryptoKey> {
        const keyData = enc.encode(secret);
        const hash = await cryptoMod.subtle.digest("SHA-256", keyData);
        return await cryptoMod.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);
      }

      async function decrypt(encryptedValue: string, key: CryptoKey): Promise<string> {
        let base64: string;
        if (encryptedValue.startsWith("\\x")) {
          const hex = encryptedValue.slice(2);
          base64 = dec.decode(new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))));
        } else {
          base64 = encryptedValue;
        }
        const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const decrypted = await cryptoMod.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
        return dec.decode(decrypted);
      }

      const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
      const now = new Date();
      const expiresAt = provider.token_expires_at ? new Date(provider.token_expires_at as string) : null;

      if (provider.access_token_encrypted && expiresAt && expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
        return await decrypt(provider.access_token_encrypted as string, encryptionKey);
      }

      const refreshToken = await decrypt(provider.refresh_token_encrypted as string, encryptionKey);

      if (provider.provider === "microsoft") {
        const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: Deno.env.get("MICROSOFT_CLIENT_ID")!,
            client_secret: Deno.env.get("MICROSOFT_CLIENT_SECRET")!,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
            scope: [
              "https://graph.microsoft.com/Mail.Read",
              "https://graph.microsoft.com/Mail.Send",
              "https://graph.microsoft.com/User.Read",
              "offline_access",
            ].join(" "),
          }),
        });
        if (!tokenRes.ok) return null;
        const tokens = await tokenRes.json();
        return tokens.access_token;
      }

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
          client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (!tokenRes.ok) return null;
      const tokens = await tokenRes.json();
      return tokens.access_token;
    } catch (e) {
      console.error("getNotificationAccessToken error:", e);
      return null;
    }
  }
