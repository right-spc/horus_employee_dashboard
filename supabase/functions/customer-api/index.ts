// ============================================
// EDGE FUNCTION: customer-api
// Authenticated gateway for the customer dashboard.
// Receives customer JWT, looks up customer_users to
// derive organization_id, and scopes all queries to
// that single org. The org is NEVER client-supplied.
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

// PayPal API base — set PAYPAL_API_BASE in Supabase secrets for live
const PAYPAL_BASE = Deno.env.get("PAYPAL_API_BASE") ?? "https://api-m.sandbox.paypal.com";
const ADDON_CREDITS = 1000;
const PAYPAL_ENV: "sandbox" | "live" = PAYPAL_BASE.includes("sandbox") ? "sandbox" : "live";

const ALLOWED_ORIGINS = [
  "https://dashboard.horusdesk.com",
  "http://localhost:5173",
  "http://localhost:4173",
];

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface DashboardAccess {
  id: string;
  organization_id: string;
  name: string;
  email: string;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Authenticate user ─────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return err("Missing authorization header", 401, cors);
  }

  const userJwt = authHeader.slice(7);

  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${userJwt}` } } }
  );

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) {
    return err("Invalid or expired token", 401, cors);
  }

  const userEmail = user.email;
  if (!userEmail) {
    return err("No email associated with this account", 403, cors);
  }

  // ── Authorization ────────────────────────────────────────────────────────────
  // Two paths grant dashboard access:
  //   1. notification_recipients with "system" in notify_on (explicit grant)
  //   2. email_providers.provider_account_email (the connected mailbox account)
  // Both are checked; results are merged and deduplicated by org_id.
  const [{ data: recipients }, { data: providers }] = await Promise.all([
    adminClient
      .schema("comms").from("notification_recipients")
      .select("id, organization_id, name, email")
      .ilike("email", userEmail)
      .eq("is_active", true)
      .contains("notify_on", ["system"]),
    adminClient
      .schema("comms").from("email_providers")
      .select("id, organization_id, provider_account_email")
      .ilike("provider_account_email", userEmail)
      .eq("status", "active"),
  ]);

  // Build unified access list, deduped by org_id
  const accessByOrg = new Map<string, DashboardAccess>();
  if (recipients) {
    for (const r of recipients) {
      accessByOrg.set(r.organization_id, r);
    }
  }
  if (providers) {
    for (const p of providers) {
      if (!accessByOrg.has(p.organization_id)) {
        accessByOrg.set(p.organization_id, {
          id: p.id,
          organization_id: p.organization_id,
          name: p.provider_account_email,
          email: p.provider_account_email,
        });
      }
    }
  }

  if (accessByOrg.size === 0) {
    return err(`Access denied — no dashboard access configured for ${userEmail}. Ask your administrator to add this email as a notification recipient with System alerts enabled.`, 403, cors);
  }

  const accessList = [...accessByOrg.values()];
  const dashAccess: DashboardAccess = accessList[0];
  const orgId = dashAccess.organization_id;
  const allOrgs = accessList.map((r) => r.organization_id);

  // ── Parse request ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON", 400, cors);
  }

  const action = body.action as string;
  if (!action) return err("Missing action", 400, cors);

  // ── Route actions ─────────────────────────────────────────────────────────
  try {
    switch (action) {
      // ── Me ──────────────────────────────────────────────────────────────
      case "me": {
        const { data: org } = await adminClient
          .schema("core").from("organizations")
          .select("id, name, slug")
          .eq("id", orgId)
          .single();

        // If user has access to multiple orgs, return the list
        let orgs = null;
        if (allOrgs.length > 1) {
          const { data: orgList } = await adminClient
            .schema("core").from("organizations")
            .select("id, name, slug")
            .in("id", allOrgs);
          orgs = orgList;
        }

        return ok({
          user: {
            id: user!.id,
            email: userEmail,
            display_name: dashAccess.name || userEmail,
          },
          org,
          orgs,
        }, cors);
      }

      // ── Overview ────────────────────────────────────────────────────────
      case "get_overview": {
        const [{ data: org }, { data: providers }, { data: widget }] = await Promise.all([
          adminClient
            .schema("core").from("organizations")
            .select(
              "name, messages_used_this_month, message_limit_per_month, ai_responses_enabled, auto_send_enabled, limit_exceeded_at"
            )
            .eq("id", orgId)
            .single(),
          adminClient
            .schema("comms").from("email_providers")
            .select(
              "provider, provider_account_email, status, emails_sent_today, daily_send_limit, watch_expiry"
            )
            .eq("organization_id", orgId)
            .limit(1),
          adminClient
            .schema("core").from("widget_configs")
            .select("id, enabled, api_key")
            .eq("organization_id", orgId)
            .maybeSingle(),
        ]);

        return ok(
          {
            org,
            provider: providers && providers.length > 0 ? providers[0] : null,
            widget,
          },
          cors
        );
      }

      // ── List conversations ──────────────────────────────────────────────
      case "list_conversations": {
        const limit = Math.min(Number(body.limit) || 50, 100);
        const offset = Number(body.offset) || 0;
        const filter = body.filter as string | undefined;

        let query = adminClient
          .schema("messaging").from("conversations")
          .select(
            "id, channel, customer_email, customer_phone, subject, status, ai_enabled, last_message_at, escalation_type, lead_priority, is_starred, last_read_at, contact:contacts(name)"
          )
          .eq("organization_id", orgId)
          .order("last_message_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (filter === "ignored") {
          // Conversations that have at least one IGNORE routing — we filter by status or do a simple join
          // For simplicity: show all conversations and let the frontend highlight ignored ones
          // Actually, let's query messages with IGNORE routing
          const { data: ignoredConvoIds } = await adminClient
            .schema("messaging").from("messages")
            .select("conversation_id")
            .eq("routing_code", "IGNORE")
            .not("conversation_id", "is", null);

          if (ignoredConvoIds && ignoredConvoIds.length > 0) {
            const ids = [...new Set(ignoredConvoIds.map((r: { conversation_id: string }) => r.conversation_id))];
            query = query.in("id", ids);
          } else {
            return ok([], cors);
          }
        }

        const { data, error } = await query;
        if (error) throw error;

        // Fetch last message preview for each conversation
        const convoIds = (data || []).map((c: { id: string }) => c.id);
        const previews: Record<string, string> = {};

        if (convoIds.length > 0) {
          const { data: recentMsgs } = await adminClient
            .schema("messaging").from("messages")
            .select("conversation_id, content, created_at")
            .in("conversation_id", convoIds)
            .order("created_at", { ascending: false })
            .limit(convoIds.length * 3);

          if (recentMsgs) {
            const seen = new Set<string>();
            for (const msg of recentMsgs) {
              if (!seen.has(msg.conversation_id)) {
                previews[msg.conversation_id] = msg.content?.slice(0, 120) || "";
                seen.add(msg.conversation_id);
              }
            }
          }
        }

        const enriched = (data || []).map((c: Record<string, unknown>) => {
          const { contact, last_read_at, ...rest } = c as Record<string, unknown> & {
            contact?: { name?: string | null } | null;
            last_read_at?: string | null;
          };
          return {
            ...rest,
            customer_name: contact?.name ?? null,
            unread: isUnread(last_read_at, rest.last_message_at as string | null),
            last_message_preview: previews[c.id as string] || null,
          };
        });

        return ok(enriched, cors);
      }

      // ── Get single conversation with messages ───────────────────────────
      case "get_conversation": {
        const { conversation_id } = body;
        if (!conversation_id) return err("Missing conversation_id", 400, cors);

        const { data: convoRow, error: convoErr } = await adminClient
          .schema("messaging").from("conversations")
          .select(
            "id, channel, customer_email, customer_phone, subject, status, ai_enabled, last_message_at, escalation_type, lead_priority, is_starred, last_read_at, contact:contacts(name)"
          )
          .eq("id", conversation_id)
          .eq("organization_id", orgId)
          .single();

        if (convoErr || !convoRow) return err("Conversation not found", 404, cors);

        const { contact, last_read_at, ...convoRest } = convoRow as Record<string, unknown> & {
          contact?: { name?: string | null } | null;
          last_read_at?: string | null;
        };
        const convo = {
          ...convoRest,
          customer_name: contact?.name ?? null,
          unread: isUnread(last_read_at, convoRest.last_message_at as string | null),
        };

        const { data: messages, error: msgErr } = await adminClient
          .schema("messaging").from("messages")
          .select(
            "id, role, content, status, routing_code, escalation_type, lead_priority, confidence_score_reported, created_at"
          )
          .eq("conversation_id", conversation_id)
          .order("created_at", { ascending: true });

        if (msgErr) throw msgErr;

        return ok({ conversation: convo, messages: messages || [] }, cors);
      }

      // ── List escalations ────────────────────────────────────────────────
      case "list_escalations": {
        const escType = body.escalation_type as string;
        const leadPri = body.lead_priority as string | undefined;

        if (!escType) return err("Missing escalation_type", 400, cors);

        let query = adminClient
          .schema("messaging").from("conversations")
          .select(
            "id, channel, customer_email, subject, status, ai_enabled, last_message_at, escalation_type, lead_priority"
          )
          .eq("organization_id", orgId)
          .eq("escalation_type", escType)
          .order("last_message_at", { ascending: false })
          .limit(50);

        if (leadPri) {
          query = query.eq("lead_priority", leadPri);
        }

        const { data, error } = await query;
        if (error) throw error;

        return ok(data || [], cors);
      }

      // ── Toggle human takeover ───────────────────────────────────────────
      case "toggle_human_takeover": {
        const { conversation_id, ai_enabled } = body;
        if (!conversation_id || ai_enabled === undefined)
          return err("Missing conversation_id or ai_enabled", 400, cors);

        const { error } = await adminClient
          .schema("messaging").from("conversations")
          .update({ ai_enabled: ai_enabled as boolean })
          .eq("id", conversation_id)
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Mark conversation as read ───────────────────────────────────────
      case "mark_conversation_read": {
        const { conversation_id } = body;
        if (!conversation_id) return err("Missing conversation_id", 400, cors);

        const { error } = await adminClient
          .schema("messaging").from("conversations")
          .update({ last_read_at: new Date().toISOString() })
          .eq("id", conversation_id)
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Star / unstar conversation ──────────────────────────────────────
      case "set_conversation_starred": {
        const { conversation_id, starred } = body;
        if (!conversation_id || starred === undefined)
          return err("Missing conversation_id or starred", 400, cors);

        const { error } = await adminClient
          .schema("messaging").from("conversations")
          .update({ is_starred: starred as boolean })
          .eq("id", conversation_id)
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Get AI settings ─────────────────────────────────────────────────
      case "get_ai_settings": {
        const { data: org, error } = await adminClient
          .schema("core").from("organizations")
          .select("ai_tone, ai_system_prompt, retention_days, auto_delete_enabled")
          .eq("id", orgId)
          .single();

        if (error) throw error;
        return ok(org, cors);
      }

      // ── Update AI settings ──────────────────────────────────────────────
      case "update_ai_settings": {
        const updates = body.updates as Record<string, unknown> | undefined;
        if (!updates || typeof updates !== "object")
          return err("Missing updates", 400, cors);

        const allowed = [
          "ai_tone",
          "ai_system_prompt",
          "retention_days",
          "auto_delete_enabled",
        ];
        const patch: Record<string, unknown> = {};
        for (const key of allowed) {
          if (key in updates) patch[key] = updates[key];
        }
        if (Object.keys(patch).length === 0)
          return err("No valid fields to update", 400, cors);

        // The system prompt has a version counter — bump it on every change.
        if ("ai_system_prompt" in patch) {
          const { data: cur } = await adminClient
            .schema("core").from("organizations")
            .select("ai_system_prompt_version")
            .eq("id", orgId)
            .single();
          patch.ai_system_prompt_version =
            ((cur?.ai_system_prompt_version as number) ?? 1) + 1;
        }

        const { error } = await adminClient
          .schema("core").from("organizations")
          .update(patch)
          .eq("id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Toggle widget ───────────────────────────────────────────────────
      case "toggle_widget": {
        const { enabled } = body;
        if (enabled === undefined) return err("Missing enabled", 400, cors);

        const { error } = await adminClient
          .schema("core").from("widget_configs")
          .update({
            enabled: enabled as boolean,
            disable_reason: enabled ? null : "manual",
          })
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Toggle email AI ─────────────────────────────────────────────────
      case "toggle_email_ai": {
        const { enabled } = body;
        if (enabled === undefined) return err("Missing enabled", 400, cors);

        const { error } = await adminClient
          .schema("core").from("organizations")
          .update({ ai_responses_enabled: enabled as boolean })
          .eq("id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Get widget config ───────────────────────────────────────────────
      case "get_widget": {
        const { data: widget } = await adminClient
          .schema("core").from("widget_configs")
          .select("*")
          .eq("organization_id", orgId)
          .maybeSingle();

        return ok({ widget }, cors);
      }

      // ── Update widget ───────────────────────────────────────────────────
      case "update_widget": {
        const { updates } = body as { updates: Record<string, unknown> };
        if (!updates) return err("Missing updates", 400, cors);

        const { error } = await adminClient
          .schema("core").from("widget_configs")
          .update(updates)
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Get email setup ─────────────────────────────────────────────────
      case "get_email_setup": {
        const { data: providers } = await adminClient
          .schema("comms").from("email_providers")
          .select(
            "provider, provider_account_email, status, emails_sent_today, daily_send_limit, watch_expiry"
          )
          .eq("organization_id", orgId)
          .limit(1);

        return ok(
          { provider: providers && providers.length > 0 ? providers[0] : null },
          cors
        );
      }

      // ── Get auth link ───────────────────────────────────────────────────
      case "get_auth_link": {
        const { provider } = body;
        if (!provider) return err("Missing provider", 400, cors);

        const fnName = provider === "google" ? "auth-google" : "auth-microsoft";
        const res = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/${fnName}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ organization_id: orgId }),
          }
        );

        const data = await res.json();
        if (!res.ok)
          throw new Error(
            data.error || data.message || `Auth function returned HTTP ${res.status}`
          );
        return ok({ url: data.url }, cors);
      }

      // ── List notification recipients ────────────────────────────────────
      case "list_recipients": {
        const { data, error } = await adminClient
          .schema("comms").from("notification_recipients")
          .select("id, email, name, notify_on, is_active")
          .eq("organization_id", orgId)
          .order("created_at", { ascending: true });

        if (error) throw error;
        return ok(data || [], cors);
      }

      // ── Add recipient ───────────────────────────────────────────────────
      case "add_recipient": {
        const { email, name, notify_on } = body;
        if (!email) return err("Missing email", 400, cors);

        const { data, error } = await adminClient
          .schema("comms").from("notification_recipients")
          .insert({
            organization_id: orgId,
            email,
            name: name || "",
            notify_on: notify_on || ["escalation"],
            is_active: true,
          })
          .select()
          .single();

        if (error) throw error;
        return ok(data, cors);
      }

      // ── Update recipient ────────────────────────────────────────────────
      case "update_recipient": {
        const { recipient_id, ...updates } = body as {
          recipient_id: string;
          [key: string]: unknown;
        };
        if (!recipient_id) return err("Missing recipient_id", 400, cors);

        delete updates.action;
        delete updates.organization_id; // Never allow org override

        const { error } = await adminClient
          .schema("comms").from("notification_recipients")
          .update(updates)
          .eq("id", recipient_id)
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── Delete recipient ────────────────────────────────────────────────
      case "delete_recipient": {
        const { recipient_id } = body;
        if (!recipient_id) return err("Missing recipient_id", 400, cors);

        const { error } = await adminClient
          .schema("comms").from("notification_recipients")
          .delete()
          .eq("id", recipient_id)
          .eq("organization_id", orgId);

        if (error) throw error;
        return ok({ success: true }, cors);
      }

      // ── List KB (read-only) ─────────────────────────────────────────────
      // Whole-KB model: the org has one versioned knowledge base. Expose the
      // active version as a single pseudo-document until the customer
      // dashboard is rebuilt around versions.
      case "list_kb_docs": {
        const { data: orgRow } = await adminClient
          .schema("core").from("organizations")
          .select("active_kb_version_id")
          .eq("id", orgId)
          .single();

        if (!orgRow?.active_kb_version_id) return ok([], cors);

        const { data: version } = await adminClient
          .schema("kb").from("kb_versions")
          .select("id, version, created_at")
          .eq("id", orgRow.active_kb_version_id)
          .single();

        if (!version) return ok([], cors);
        return ok([{
          id: version.id,
          title: "Knowledge Base",
          file_type: "markdown",
          status: "ready",
          created_at: version.created_at,
          version: version.version,
        }], cors);
      }

      // ── Get KB content (sections of a KB version) ───────────────────────
      case "get_kb_chunks": {
        const { doc_id } = body;
        if (!doc_id) return err("Missing doc_id", 400, cors);

        // Verify the version belongs to this org
        const { data: version, error } = await adminClient
          .schema("kb").from("kb_versions")
          .select("id, sections")
          .eq("id", doc_id)
          .eq("organization_id", orgId)
          .single();

        if (error || !version) return err("KB version not found", 404, cors);

        const sections = (version.sections as Array<{ title?: string; body?: string }>) || [];
        const chunks = sections.map((s) => ({
          id: version.id,
          chunk_code: null,
          heading: s.title || null,
          content: s.title ? `## ${s.title}\n\n${s.body ?? ""}` : (s.body ?? ""),
        }));
        return ok({ chunks }, cors);
      }

      // ── Submit KB amend request ─────────────────────────────────────────
      case "submit_kb_amend": {
        const { title, document_id, content } = body;
        if (!title || !content)
          return err("Missing title or content", 400, cors);

        const { data, error } = await adminClient
          .schema("kb").from("kb_amend_requests")
          .insert({
            organization_id: orgId,
            requested_by: null,
            title,
            document_id: document_id || null,
            content,
          })
          .select()
          .single();

        if (error) throw error;
        return ok(data, cors);
      }

      // ── List KB amend requests ──────────────────────────────────────────
      case "list_kb_amend_requests": {
        const { data, error } = await adminClient
          .schema("kb").from("kb_amend_requests")
          .select("id, title, document_id, content, status, reviewer_notes, created_at")
          .eq("organization_id", orgId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return ok(data || [], cors);
      }

      // ── List payments for this org ──────────────────────────────────────
      case "list_payments": {
        const { data, error } = await adminClient
          .schema("billing").from("payment_history")
          .select("id, amount, currency, category, description, status, credits_added, created_at, paypal_order_id")
          .eq("organization_id", orgId)
          .order("created_at", { ascending: false });

        if (error) throw error;
        return ok(data || [], cors);
      }

      // ── PayPal: create order for an awaiting_payment invoice ───────────
      case "paypal_create_order": {
        const { payment_id } = body as { payment_id: string };
        if (!payment_id) return err("Missing payment_id", 400, cors);

        const { data: payment, error: fetchErr } = await adminClient
          .schema("billing").from("payment_history")
          .select("id, amount, description, category, status")
          .eq("id", payment_id)
          .eq("organization_id", orgId)
          .single();

        if (fetchErr || !payment) return err("Payment not found", 404, cors);
        if (payment.status !== "awaiting_payment") {
          return err("This payment is not awaiting payment", 400, cors);
        }

        const trace = crypto.randomUUID().slice(0, 8);
        paypalLog("customer.create_order", {
          trace, org_id: orgId, payment_id, amount: payment.amount,
        });

        const order = await paypalCreateOrder(payment.amount, payment.description, trace);

        await adminClient
          .schema("billing").from("payment_history")
          .update({ paypal_order_id: order.id })
          .eq("id", payment_id)
          .eq("organization_id", orgId);

        return ok({ id: order.id }, cors);
      }

      // ── PayPal: capture order for an invoice ───────────────────────────
      case "paypal_capture_order": {
        const { payment_id, order_id } = body as { payment_id: string; order_id: string };
        if (!payment_id || !order_id) return err("Missing payment_id or order_id", 400, cors);

        const { data: payment, error: fetchErr } = await adminClient
          .schema("billing").from("payment_history")
          .select("id, amount, description, category, status, paypal_order_id")
          .eq("id", payment_id)
          .eq("organization_id", orgId)
          .single();

        if (fetchErr || !payment) return err("Payment not found", 404, cors);
        if (payment.paypal_order_id !== order_id) {
          return err("Order ID mismatch", 400, cors);
        }

        const trace = crypto.randomUUID().slice(0, 8);
        paypalLog("customer.capture_order", {
          trace, org_id: orgId, payment_id, order_id,
        });

        const capture = await paypalCaptureOrder(order_id, trace);

        if (capture.status !== "COMPLETED") {
          paypalLog("customer.capture.not_completed", {
            trace, order_id, paypal_status: capture.status,
          });
          await adminClient.schema("billing").from("payment_history").update({
            status: "failed",
            paypal_capture_id: capture.captureId,
            payer_email: capture.payerEmail,
          }).eq("id", payment_id).eq("organization_id", orgId);

          return err(`PayPal capture status: ${capture.status}`, 502, cors);
        }

        // Apply side-effects (same logic as dashboard-api)
        let creditsAdded: number | null = null;

        if (payment.category === "monthly" || payment.category === "yearly") {
          const result = await extendSubscription(adminClient, orgId, payment.category);
          if (!result.ok) return err(result.error!, result.status!, cors);
        } else if (payment.category === "addon") {
          const { data: orgRow, error: orgErr } = await adminClient
            .schema("core").from("organizations")
            .select("addon_credits")
            .eq("id", orgId)
            .single();
          if (orgErr) throw orgErr;
          creditsAdded = ADDON_CREDITS;
          await adminClient
            .schema("core").from("organizations")
            .update({ addon_credits: (orgRow?.addon_credits ?? 0) + ADDON_CREDITS })
            .eq("id", orgId);
          await adminClient
            .schema("core").from("widget_configs")
            .update({ enabled: true, disable_reason: null, disable_message: null })
            .eq("organization_id", orgId)
            .eq("disable_reason", "usage_limit");
          await adminClient
            .schema("core").from("organizations")
            .update({ limit_exceeded_at: null, limit_notified_at: null })
            .eq("id", orgId);
        }

        await adminClient.schema("billing").from("payment_history").update({
          status: "completed",
          paypal_capture_id: capture.captureId,
          payer_email: capture.payerEmail,
          credits_added: creditsAdded,
        }).eq("id", payment_id).eq("organization_id", orgId);

        paypalLog("customer.capture_order.completed", {
          trace, org_id: orgId, payment_id, order_id, credits_added: creditsAdded,
        });

        return ok({
          success: true,
          capture_id: capture.captureId,
          payer_email: capture.payerEmail,
        }, cors);
      }

      // ── Unknown action ──────────────────────────────────────────────────
      default:
        return err(`Unknown action: ${action}`, 400, cors);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error
      ? e.message
      : (e as { message?: string })?.message || JSON.stringify(e) || "Internal error";
    console.error(`customer-api error [${action}]:`, msg);
    return err(msg, 500, cors);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// A conversation is unread if it has never been opened in the dashboard, or a
// newer message has arrived since it was last opened.
function isUnread(
  lastReadAt: string | null | undefined,
  lastMessageAt: string | null | undefined
): boolean {
  if (!lastMessageAt) return false;
  if (!lastReadAt) return true;
  return new Date(lastReadAt).getTime() < new Date(lastMessageAt).getTime();
}

function err(
  message: string,
  status: number,
  cors: Record<string, string>
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── Date utility ─────────────────────────────────────────────────────────────
// Extend a date by N calendar months, clamped to the last day of the target month.
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

// ── Subscription extension ───────────────────────────────────────────────────
async function extendSubscription(
  adminClient: ReturnType<typeof createClient>,
  orgId: string,
  plan?: string
): Promise<{ ok: boolean; newEndDate?: string; error?: string; status?: number }> {
  const { data: currentOrg, error: fetchErr } = await adminClient
    .schema("core").from("organizations")
    .select("subscription_plan, subscription_end_date")
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

  await adminClient
    .schema("core").from("widget_configs")
    .update({ enabled: true, disable_reason: null, disable_message: null })
    .eq("organization_id", orgId)
    .eq("disable_reason", "subscription_expired");

  return { ok: true, newEndDate: newEndDate.toISOString() };
}

// ── PayPal client (server-side) ──────────────────────────────────────────────

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
      application_context: {
        brand_name: "Horus Desk",
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
