// ============================================
// EDGE FUNCTION: cron-maintenance
// Handles seven scheduled maintenance tasks:
//
// 1. Gmail watch renewal (daily)
//    Gmail Push watches expire every 7 days.
//    Renew any watch expiring within 2 days.
//
// 2. Microsoft Graph subscription renewal (daily)
//    Graph subscriptions expire every 3 days max.
//    Renew any subscription expiring within 1 day.
//
// 3. Daily email counter reset (daily)
//    Resets emails_sent_today on email_providers
//    where last_reset_date < today.
//
// 4. Expired subscription enforcement (daily)
//    Disables AI + widget for orgs past their
//    subscription_end_date.
//
// 5. Per-org message retention cleanup (daily)
//    Deletes messages older than each org's
//    retention_days window (3, 7, 30, or 365),
//    plus any conversation left empty afterwards.
//
// 6. Process due export schedules (daily)
//    Iterates active export_schedules whose
//    next_run_at has passed, calls export-messages
//    for each, and advances next_run_at.
//
// 7. Calendly token refresh & event type sync (daily)
//    Refreshes Calendly OAuth tokens expiring within
//    30 minutes and syncs event type caches.
//
// Schedule: Run once daily. Supabase dashboard →
// Edge Functions → cron-maintenance → Schedule
// Cron expression: 0 0 * * *  (00:00 AM UTC daily)
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const results = {
    gmail_watches_renewed: 0,
    gmail_watch_errors: 0,
    graph_subscriptions_renewed: 0,
    graph_subscription_errors: 0,
    email_counters_reset: 0,
    expiry_reminders_sent: 0,
    grace_periods_started: 0,
    final_warnings_sent: 0,
    subscriptions_expired: 0,
    messages_deleted: 0,
    conversations_deleted: 0,
    retention_errors: 0,
    exports_run: 0,
    export_errors: 0,
    calendly_tokens_refreshed: 0,
    calendly_event_types_synced: 0,
    calendly_errors: 0,
    gcal_tokens_refreshed: 0,
    gcal_errors: 0,
  };

  const GRACE_PERIOD_DAYS = 7;

  // ── Task 1: Renew Gmail watches ───────────────────────────────────────────
  // Find active Google providers whose watch expires within 48 hours
  const gmailRenewalCutoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  const { data: gmailProviders, error: gmailFetchError } = await supabase
    .schema("comms").from("email_providers")
    .select("id, organization_id, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, watch_expiry")
    .eq("provider", "google")
    .eq("status", "active")
    .or(`watch_expiry.is.null,watch_expiry.lte.${gmailRenewalCutoff}`);

  if (gmailFetchError) {
    console.error("Failed to fetch Gmail providers:", gmailFetchError.message);
  } else if (gmailProviders && gmailProviders.length > 0) {
    console.log(`Renewing ${gmailProviders.length} Gmail watch(es)...`);

    for (const provider of gmailProviders) {
      try {
        const accessToken = await getAccessToken(supabase, provider, "google");

        const topicName = Deno.env.get("GMAIL_PUBSUB_TOPIC")!;
        const watchRes = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/watch",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              topicName,
              labelIds: ["INBOX"],
            }),
          }
        );

        if (!watchRes.ok) {
          const err = await watchRes.text();
          throw new Error(`Gmail watch API error: ${err}`);
        }

        const watchData = await watchRes.json();
        const newExpiry = new Date(parseInt(watchData.expiration)).toISOString();

        await supabase
          .schema("comms").from("email_providers")
          .update({
            watch_expiry: newExpiry,
            last_history_id: watchData.historyId ?? provider.last_history_id,
            error_message: null,
          })
          .eq("id", provider.id);

        console.log(`Gmail watch renewed for ${provider.provider_account_email}, expires ${newExpiry}`);
        results.gmail_watches_renewed++;
      } catch (e) {
        console.error(`Failed to renew Gmail watch for ${provider.provider_account_email}:`, e.message);

        await supabase
          .schema("comms").from("email_providers")
          .update({ error_message: `Watch renewal failed: ${e.message}` })
          .eq("id", provider.id);

        results.gmail_watch_errors++;
      }
    }
  } else {
    console.log("No Gmail watches need renewal.");
  }

  // ── Task 2: Renew Microsoft Graph subscriptions ───────────────────────────
  // Find active Microsoft providers whose subscription expires within 24 hours.
  // Graph subscriptions max out at 3 days — we renew within 1 day of expiry.
  const graphRenewalCutoff = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

  const { data: msProviders, error: msFetchError } = await supabase
    .schema("comms").from("email_providers")
    .select("id, organization_id, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, watch_expiry, last_history_id")
    .eq("provider", "microsoft")
    .eq("status", "active")
    .or(`watch_expiry.is.null,watch_expiry.lte.${graphRenewalCutoff}`);

  if (msFetchError) {
    console.error("Failed to fetch Microsoft providers:", msFetchError.message);
  } else if (msProviders && msProviders.length > 0) {
    console.log(`Renewing ${msProviders.length} Microsoft Graph subscription(s)...`);

    for (const provider of msProviders) {
      try {
        const accessToken = await getAccessToken(supabase, provider, "microsoft");
        const subscriptionId = provider.last_history_id; // We store subscription ID here

        // New expiry: 3 days from now (Microsoft's maximum for mail subscriptions)
        const newExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

        let finalSubscriptionId: string;
        let finalExpiry: string;

        if (subscriptionId) {
          // Try to renew existing subscription via PATCH
          const renewRes = await fetch(
            `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expirationDateTime: newExpiry }),
            }
          );

          if (renewRes.ok) {
            const renewData = await renewRes.json();
            finalSubscriptionId = renewData.id;
            finalExpiry = renewData.expirationDateTime;
            console.log(`Graph subscription renewed for ${provider.provider_account_email}`);
          } else {
            // Subscription may have expired — create a new one
            console.warn(`Graph PATCH failed for ${provider.provider_account_email}, creating new subscription...`);
            const { id, expiry } = await createGraphSubscription(accessToken, provider.organization_id);
            finalSubscriptionId = id;
            finalExpiry = expiry;
          }
        } else {
          // No existing subscription — create one
          const { id, expiry } = await createGraphSubscription(accessToken, provider.organization_id);
          finalSubscriptionId = id;
          finalExpiry = expiry;
        }

        await supabase
          .schema("comms").from("email_providers")
          .update({
            last_history_id: finalSubscriptionId,
            watch_expiry: finalExpiry,
            error_message: null,
          })
          .eq("id", provider.id);

        results.graph_subscriptions_renewed++;
      } catch (e) {
        console.error(`Failed to renew Graph subscription for ${provider.provider_account_email}:`, e.message);

        await supabase
          .schema("comms").from("email_providers")
          .update({ error_message: `Subscription renewal failed: ${e.message}` })
          .eq("id", provider.id);

        results.graph_subscription_errors++;
      }
    }
  } else {
    console.log("No Microsoft Graph subscriptions need renewal.");
  }

  // ── Task 3: Reset daily email counters ────────────────────────────────────
  // Reset emails_sent_today for any provider whose last_reset_date is before today.

  const { data: resetResult, error: resetError } = await supabase
    .schema("comms").from("email_providers")
    .update({
      emails_sent_today: 0,
      last_reset_date: new Date().toISOString().split("T")[0],
    })
    .lt("last_reset_date", new Date().toISOString().split("T")[0])
    .select("id");

  if (resetError) {
    console.error("Failed to reset email counters:", resetError.message);
  } else {
    results.email_counters_reset = resetResult?.length ?? 0;
    if (results.email_counters_reset > 0) {
      console.log(`Reset email counters for ${results.email_counters_reset} provider(s).`);
    } else {
      console.log("No email counters needed resetting.");
    }
  }

  // ── Task 3b: Upcoming expiry reminder (3 days before subscription_end_date) ─
  // Send a reminder to orgs whose subscription expires within 3 days, but ONLY
  // if no payment has already extended them past the current end date. We use
  // suspension_warning_sent_at as a "reminder already sent" flag — it's NULL
  // until either this reminder or the grace-period warning fires.
  const nowIso = new Date().toISOString();
  const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const { data: expiringOrgs, error: expiringErr } = await supabase
    .schema("core").from("organizations")
    .select("id, name, subscription_end_date")
    .not("subscription_end_date", "is", null)
    .gt("subscription_end_date", nowIso)          // not yet expired
    .lte("subscription_end_date", threeDaysOut)   // expires within 3 days
    .eq("ai_responses_enabled", true)
    .is("grace_period_ends_at", null)             // no grace period yet
    .is("suspension_warning_sent_at", null)        // reminder not already sent
    .eq("is_demo", false);

  if (expiringErr) {
    console.error("Failed to fetch soon-expiring orgs:", expiringErr.message);
  } else if (expiringOrgs && expiringOrgs.length > 0) {
    console.log(`Sending expiry reminders to ${expiringOrgs.length} org(s)...`);

    for (const org of expiringOrgs) {
      const endDate = new Date(org.subscription_end_date as string);
      const daysLeft = Math.max(1, Math.ceil((endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
      const endStr = endDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

      const subject = `Your Horus Desk subscription expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
      const body = [
        `Hi,`,
        ``,
        `This is a friendly reminder that your subscription for ${org.name} expires on ${endStr}.`,
        ``,
        `To keep your AI receptionist and chat widget running without interruption,`,
        `please renew before the expiry date.`,
        ``,
        `If you've already arranged payment, you can disregard this email.`,
        ``,
        `Thank you,`,
        `Horus Desk`,
      ].join("\n");

      try {
        await sendOrgNotification(supabase, org.id, "system", subject, body);
      } catch (e) {
        console.error(`Failed to send expiry reminder for ${org.name}:`, e);
      }

      // Mark reminder as sent so we don't re-send tomorrow
      await supabase
        .schema("core").from("organizations")
        .update({ suspension_warning_sent_at: nowIso })
        .eq("id", org.id);

      console.log(`Expiry reminder sent for org ${org.name} (expires ${endStr})`);
      results.expiry_reminders_sent++;
    }
  } else {
    console.log("No upcoming-expiry reminders needed.");
  }

  // ── Task 4a: Start grace period for newly expired subscriptions ────────────
  // Orgs whose subscription_end_date has passed AND who don't yet have a grace
  // period set get a warning email + a grace_period_ends_at 7 days out.
  // The widget stays enabled until the grace period ends.
  const { data: newlyExpired, error: newlyExpiredErr } = await supabase
    .schema("core").from("organizations")
    .select("id, name, subscription_end_date")
    .not("subscription_end_date", "is", null)
    .lt("subscription_end_date", nowIso)
    .eq("ai_responses_enabled", true)
    .is("grace_period_ends_at", null);

  if (newlyExpiredErr) {
    console.error("Failed to fetch newly expired orgs:", newlyExpiredErr.message);
  } else if (newlyExpired && newlyExpired.length > 0) {
    console.log(`Starting grace period for ${newlyExpired.length} org(s)...`);

    for (const org of newlyExpired) {
      const graceEnd = new Date(
        new Date(org.subscription_end_date as string).getTime()
        + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
      );

      await supabase
        .schema("core").from("organizations")
        .update({
          grace_period_ends_at: graceEnd.toISOString(),
          suspension_warning_sent_at: nowIso,
        })
        .eq("id", org.id);

      const subject = `Your Horus Desk subscription has expired`;
      const body = [
        `Hi,`,
        ``,
        `Your subscription for ${org.name} expired on ${new Date(org.subscription_end_date as string).toUTCString()}.`,
        ``,
        `To avoid any interruption, please renew within ${GRACE_PERIOD_DAYS} days.`,
        `If we don't receive a renewal by ${graceEnd.toUTCString()}, your AI receptionist`,
        `and chat widget will be temporarily suspended until you renew.`,
        ``,
        `Thank you,`,
        `Horus Desk`,
      ].join("\n");

      try {
        await sendOrgNotification(supabase, org.id, "system", subject, body);
      } catch (e) {
        console.error(`Failed to send grace period warning for ${org.name}:`, e);
      }

      console.log(`Grace period started for org ${org.name} until ${graceEnd.toISOString()}`);
      results.grace_periods_started++;
    }
  }

  // ── Task 4a-ii: Final warning — 1 day before grace period ends ──────────────
  // For orgs in grace whose grace_period_ends_at is within 1 day AND service is
  // still enabled. We check that suspension_warning_sent_at < grace_period_ends_at
  // minus 2 days so we only send the final warning once (the initial grace warning
  // set suspension_warning_sent_at earlier).
  const oneDayOut = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

  const { data: finalWarnOrgs, error: finalWarnErr } = await supabase
    .schema("core").from("organizations")
    .select("id, name, grace_period_ends_at")
    .not("grace_period_ends_at", "is", null)
    .gt("grace_period_ends_at", nowIso)            // grace hasn't ended yet
    .lte("grace_period_ends_at", oneDayOut)         // ends within 1 day
    .eq("ai_responses_enabled", true)
    .eq("is_demo", false);

  if (finalWarnErr) {
    console.error("Failed to fetch final-warning orgs:", finalWarnErr.message);
  } else if (finalWarnOrgs && finalWarnOrgs.length > 0) {
    // Filter to only orgs where we haven't already sent the final warning.
    // We detect this by checking suspension_warning_sent_at — the initial
    // grace warning set it to when grace started. If it's been updated to
    // within the last 2 days, the final warning was already sent.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    for (const org of finalWarnOrgs) {
      // Re-fetch to check suspension_warning_sent_at (not in the select above
      // to keep the query simple)
      const { data: orgCheck } = await supabase
        .schema("core").from("organizations")
        .select("suspension_warning_sent_at")
        .eq("id", org.id)
        .single();

      // If we already updated suspension_warning_sent_at in the last 2 days,
      // this is likely the final warning already sent — skip.
      if (orgCheck?.suspension_warning_sent_at &&
          orgCheck.suspension_warning_sent_at > twoDaysAgo) {
        continue;
      }

      const graceEnd = new Date(org.grace_period_ends_at as string);
      const graceEndStr = graceEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

      const subject = `FINAL WARNING — Horus Desk service for ${org.name} will be suspended tomorrow`;
      const body = [
        `Hi,`,
        ``,
        `This is a final reminder that your Horus Desk service for ${org.name}`,
        `will be suspended on ${graceEndStr} unless we receive a renewal payment.`,
        ``,
        `Once suspended, your AI receptionist will stop responding to emails`,
        `and your chat widget will be disabled. Service will be restored`,
        `immediately upon renewal.`,
        ``,
        `Please renew as soon as possible to avoid any interruption.`,
        ``,
        `Thank you,`,
        `Horus Desk`,
      ].join("\n");

      try {
        await sendOrgNotification(supabase, org.id, "system", subject, body);
      } catch (e) {
        console.error(`Failed to send final warning for ${org.name}:`, e);
      }

      // Update timestamp so we don't re-send
      await supabase
        .schema("core").from("organizations")
        .update({ suspension_warning_sent_at: nowIso })
        .eq("id", org.id);

      console.log(`Final warning sent for org ${org.name} (grace ends ${graceEndStr})`);
      results.final_warnings_sent++;
    }
  } else {
    console.log("No final warnings needed.");
  }

  // ── Task 4b: Disable orgs whose grace period has ended ─────────────────────
  const { data: pastGrace, error: pastGraceErr } = await supabase
    .schema("core").from("organizations")
    .select("id, name, grace_period_ends_at")
    .not("grace_period_ends_at", "is", null)
    .lt("grace_period_ends_at", nowIso)
    .eq("ai_responses_enabled", true);

  if (pastGraceErr) {
    console.error("Failed to fetch past-grace orgs:", pastGraceErr.message);
  } else if (pastGrace && pastGrace.length > 0) {
    console.log(`Suspending ${pastGrace.length} past-grace org(s)...`);

    for (const org of pastGrace) {
      await supabase
        .schema("core").from("organizations")
        .update({ ai_responses_enabled: false })
        .eq("id", org.id);

      await supabase
        .schema("core").from("widget_configs")
        .update({
          enabled: false,
          disable_reason: "subscription_expired",
          disable_message: "Your subscription has expired. Please renew to restore service.",
        })
        .eq("organization_id", org.id)
        .neq("disable_reason", "subscription_expired");

      // Send service-suspended notification
      const suspendSubject = `Horus Desk service for ${org.name} has been suspended`;
      const suspendBody = [
        `Hi,`,
        ``,
        `Your Horus Desk service for ${org.name} has been suspended due to`,
        `an expired subscription.`,
        ``,
        `Effective immediately:`,
        `  • Your AI receptionist will no longer respond to emails`,
        `  • Your chat widget has been disabled`,
        ``,
        `To restore service, please renew your subscription. Service will`,
        `resume immediately once payment is received.`,
        ``,
        `If you believe this is an error, please contact us.`,
        ``,
        `Thank you,`,
        `Horus Desk`,
      ].join("\n");

      try {
        await sendOrgNotification(supabase, org.id, "system", suspendSubject, suspendBody);
      } catch (e) {
        console.error(`Failed to send suspension notice for ${org.name}:`, e);
      }

      console.log(`Disabled past-grace org: ${org.name}`);
      results.subscriptions_expired++;
    }
  } else {
    console.log("No past-grace orgs to suspend.");
  }

  // ── Task 5: Per-org message retention cleanup ─────────────────────────────
  // Delete messages older than each org's retention window, then drop any
  // conversation that ends up with zero remaining messages.
  try {
    const { data: retentionOrgs, error: retentionOrgsErr } = await supabase
      .schema("core").from("organizations")
      .select("id, retention_days");

    if (retentionOrgsErr) throw retentionOrgsErr;

    for (const org of retentionOrgs ?? []) {
      const days = (org.retention_days as number | null) ?? 365;
      const cutoffIso = new Date(Date.now() - days * 86400000).toISOString();

      const { data: deletedMsgs, error: msgErr } = await supabase
        .schema("messaging").from("messages")
        .delete()
        .eq("organization_id", org.id)
        .lt("created_at", cutoffIso)
        .select("id, conversation_id");

      if (msgErr) {
        console.error(`[retention] org ${org.id} message delete failed:`, msgErr.message);
        results.retention_errors++;
        continue;
      }

      results.messages_deleted += deletedMsgs?.length ?? 0;

      // Re-check each touched conversation; if empty, delete it.
      const touchedConvIds = Array.from(
        new Set(
          (deletedMsgs ?? [])
            .map((m) => m.conversation_id as string | null)
            .filter((id): id is string => !!id)
        )
      );

      for (const convId of touchedConvIds) {
        const { count, error: countErr } = await supabase
          .schema("messaging").from("messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", convId);

        if (countErr) {
          console.error(`[retention] count failed for conv ${convId}:`, countErr.message);
          results.retention_errors++;
          continue;
        }

        if ((count ?? 0) === 0) {
          const { error: convErr } = await supabase
            .schema("messaging").from("conversations")
            .delete()
            .eq("id", convId)
            .eq("organization_id", org.id);

          if (convErr) {
            console.error(`[retention] conv delete failed for ${convId}:`, convErr.message);
            results.retention_errors++;
          } else {
            results.conversations_deleted++;
          }
        }
      }
    }

    console.log(
      `[retention] deleted ${results.messages_deleted} message(s), ` +
      `${results.conversations_deleted} empty conversation(s), ` +
      `${results.retention_errors} error(s).`
    );
  } catch (e) {
    console.error("[retention] task failed:", (e as Error).message);
    results.retention_errors++;
  }

  // ── Task 6: Process due export schedules ─────────────────────────────────
  // For each active export_schedules row whose next_run_at has passed, invoke
  // the export-messages edge function with the appropriate window, then
  // advance next_run_at by the schedule's cadence.
  try {
    const exportNowIso = new Date().toISOString();
    const { data: dueSchedules, error: dueErr } = await supabase
      .schema("comms").from("export_schedules")
      .select("id, organization_id, frequency, recipient_email")
      .eq("is_active", true)
      .lte("next_run_at", exportNowIso);

    if (dueErr) throw dueErr;

    for (const sch of dueSchedules ?? []) {
      const days = ({ daily: 1, weekly: 7, monthly: 30, quarterly: 90 } as const)[
        sch.frequency as "daily" | "weekly" | "monthly" | "quarterly"
      ];
      const end = new Date();
      const start = new Date(end.getTime() - days * 86400000);

      // Compute next run from now (not from prior next_run_at) so a missed
      // cron tick doesn't cascade backlog runs. Aligned to 00:00 UTC to match
      // the cron-maintenance tick (0 0 * * *).
      const nextDate = new Date();
      nextDate.setUTCHours(0, 0, 0, 0);
      nextDate.setUTCDate(nextDate.getUTCDate() + days);

      try {
        const res = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/export-messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({
              org_id: sch.organization_id,
              start_date: start.toISOString(),
              end_date: end.toISOString(),
              recipient_email: sch.recipient_email,
            }),
          }
        );
        const payload = await res.json();

        await supabase
          .schema("comms").from("export_schedules")
          .update({
            last_run_at: exportNowIso,
            last_run_status: res.ok ? "success" : "error",
            last_run_error: res.ok ? null : (payload.error ?? "unknown"),
            last_run_url: res.ok ? payload.url ?? null : null,
            next_run_at: nextDate.toISOString(),
          })
          .eq("id", sch.id);

        if (res.ok) {
          results.exports_run++;
        } else {
          results.export_errors++;
          console.error(`[exports] schedule ${sch.id} returned ${res.status}: ${payload.error}`);
        }
      } catch (e) {
        console.error(`[exports] schedule ${sch.id} failed:`, (e as Error).message);
        results.export_errors++;
        await supabase
          .schema("comms").from("export_schedules")
          .update({
            last_run_at: exportNowIso,
            last_run_status: "error",
            last_run_error: (e as Error).message,
            next_run_at: nextDate.toISOString(),
          })
          .eq("id", sch.id);
      }
    }

    console.log(
      `[exports] ran ${results.exports_run} export(s), ${results.export_errors} error(s).`
    );
  } catch (e) {
    console.error("[exports] task failed:", (e as Error).message);
    results.export_errors++;
  }

  // ── Task 7: Refresh Calendly tokens & sync event types ─────────────────────
  try {
    const calendlyRefreshCutoff = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: calendlyIntegrations } = await supabase
      .schema("comms").from("integrations")
      .select("*")
      .eq("integration_type", "calendly")
      .eq("status", "active")
      .lt("credentials_expires_at", calendlyRefreshCutoff);

    for (const integration of calendlyIntegrations || []) {
      try {
        const credentialsJson = await decryptValue(integration.credentials_encrypted);
        const credentials = JSON.parse(credentialsJson);

        const tokenResponse = await fetch("https://auth.calendly.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credentials.refresh_token,
            client_id: Deno.env.get("CALENDLY_CLIENT_ID")!,
            client_secret: Deno.env.get("CALENDLY_CLIENT_SECRET")!,
          }),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          console.error(`Calendly token refresh failed for integration ${integration.id}:`, errText);
          await supabase.schema("comms").from("integrations").update({
            status: "error",
            last_error: `Token refresh failed: ${errText}`,
            error_count: (integration.error_count || 0) + 1,
          }).eq("id", integration.id);
          results.calendly_errors++;
          continue;
        }

        const tokens = await tokenResponse.json();
        const newExpiry = new Date(Date.now() + (tokens.expires_in || 7200) * 1000);

        const newCredentials = JSON.stringify({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || credentials.refresh_token,
        });
        const encryptedCredentials = await encryptValue(newCredentials);

        // Also refresh event types cache
        let updatedConfig = integration.config || {};
        try {
          const userUri = (integration.config as any)?.calendly_user_uri;
          if (userUri) {
            const etRes = await fetch(
              `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&active=true&count=25`,
              { headers: { Authorization: `Bearer ${tokens.access_token}` } }
            );
            if (etRes.ok) {
              const etData = await etRes.json();
              updatedConfig = {
                ...updatedConfig,
                event_types: (etData.collection || []).map((et: any) => ({
                  uri: et.uri,
                  name: et.name,
                  duration: et.duration,
                  slug: et.slug,
                })),
              };
              results.calendly_event_types_synced++;
            }
          }
        } catch (e) {
          console.warn("Event types sync failed, keeping existing:", (e as Error).message);
        }

        await supabase.schema("comms").from("integrations").update({
          credentials_encrypted: encryptedCredentials,
          credentials_expires_at: newExpiry.toISOString(),
          config: updatedConfig,
          status: "active",
          last_error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", integration.id);

        results.calendly_tokens_refreshed++;
      } catch (e) {
        console.error(`Calendly maintenance failed for integration ${integration.id}:`, (e as Error).message);
        results.calendly_errors++;
      }
    }

    if ((calendlyIntegrations?.length ?? 0) > 0) {
      console.log(
        `[calendly] refreshed ${results.calendly_tokens_refreshed} token(s), synced ${results.calendly_event_types_synced} event type caches, ${results.calendly_errors} error(s).`
      );
    }
  } catch (e) {
    console.error("[calendly] task failed:", (e as Error).message);
    results.calendly_errors++;
  }

  // ── Task 8: Refresh Google Calendar integration tokens ──────────────────────
  try {
    const gcalRefreshCutoff = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: gcalIntegrations } = await supabase
      .schema("comms").from("integrations")
      .select("*")
      .eq("integration_type", "google_calendar")
      .eq("status", "active")
      .lt("credentials_expires_at", gcalRefreshCutoff);

    for (const integration of gcalIntegrations || []) {
      try {
        const credentialsJson = await decryptValue(integration.credentials_encrypted);
        const credentials = JSON.parse(credentialsJson);

        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credentials.refresh_token,
            client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
            client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
          }),
        });

        if (!tokenResponse.ok) {
          const errText = await tokenResponse.text();
          console.error(`Google Calendar token refresh failed for integration ${integration.id}:`, errText);
          await supabase.schema("comms").from("integrations").update({
            status: "error",
            last_error: `Token refresh failed: ${errText}`,
            error_count: (integration.error_count || 0) + 1,
          }).eq("id", integration.id);
          results.gcal_errors++;
          continue;
        }

        const tokens = await tokenResponse.json();
        const newExpiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

        const newCredentials = JSON.stringify({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || credentials.refresh_token,
        });
        const encryptedCredentials = await encryptValue(newCredentials);

        // Also refresh calendar list cache
        let updatedConfig = integration.config || {};
        try {
          const calRes = await fetch(
            "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer",
            { headers: { Authorization: `Bearer ${tokens.access_token}` } }
          );
          if (calRes.ok) {
            const calData = await calRes.json();
            updatedConfig = {
              ...updatedConfig,
              calendars: (calData.items || []).map((cal: any) => ({
                id: cal.id,
                summary: cal.summary || cal.id,
                primary: !!cal.primary,
              })),
            };
          }
        } catch (e) {
          console.warn("Calendar list sync failed, keeping existing:", (e as Error).message);
        }

        await supabase.schema("comms").from("integrations").update({
          credentials_encrypted: encryptedCredentials,
          credentials_expires_at: newExpiry.toISOString(),
          config: updatedConfig,
          status: "active",
          last_error: null,
          updated_at: new Date().toISOString(),
        }).eq("id", integration.id);

        results.gcal_tokens_refreshed++;
      } catch (e) {
        console.error(`Google Calendar maintenance failed for integration ${integration.id}:`, (e as Error).message);
        results.gcal_errors++;
      }
    }

    if ((gcalIntegrations?.length ?? 0) > 0) {
      console.log(
        `[google_calendar] refreshed ${results.gcal_tokens_refreshed} token(s), ${results.gcal_errors} error(s).`
      );
    }
  } catch (e) {
    console.error("[google_calendar] task failed:", (e as Error).message);
    results.gcal_errors++;
  }

  console.log("cron-maintenance complete:", results);

  return new Response(JSON.stringify({ status: "ok", ...results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// ── Create a new Microsoft Graph subscription ─────────────────────────────────

async function createGraphSubscription(
  accessToken: string,
  organizationId: string
): Promise<{ id: string; expiry: string }> {
  const notificationUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/handle-inbound-email`;
  const expiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource: "me/mailFolders('Inbox')/messages",
      expirationDateTime: expiry,
      clientState: Deno.env.get("MICROSOFT_WEBHOOK_SECRET") ?? "horus-desk",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph subscription creation failed: ${err}`);
  }

  const data = await res.json();
  return { id: data.id, expiry: data.expirationDateTime };
}

// ── Standalone encrypt/decrypt for integration credentials ───────────────────

async function decryptValue(encryptedValue: string): Promise<string> {
  const keyData = encoder.encode(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  const key = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["decrypt"]);

  let base64: string;
  if (encryptedValue.startsWith("\\x")) {
    const hex = encryptedValue.slice(2);
    base64 = decoder.decode(
      new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
    );
  } else {
    base64 = encryptedValue;
  }
  const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return decoder.decode(decrypted);
}

async function encryptValue(text: string): Promise<string> {
  const keyData = encoder.encode(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  const key = await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt"]);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, encoder.encode(text)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

// ── Token helper ──────────────────────────────────────────────────────────────
// Gets a valid access token for either Google or Microsoft,
// refreshing if expired. Updates the provider record.

async function getAccessToken(
  supabase: ReturnType<typeof createClient>,
  provider: Record<string, unknown>,
  providerType: "google" | "microsoft"
): Promise<string> {

  async function getKey(secret: string): Promise<CryptoKey> {
    const keyData = encoder.encode(secret);
    const hash = await crypto.subtle.digest("SHA-256", keyData);
    return await crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async function decrypt(encryptedValue: string, key: CryptoKey): Promise<string> {
    let base64: string;
    if (encryptedValue.startsWith("\\x")) {
      const hex = encryptedValue.slice(2);
      base64 = decoder.decode(
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)))
      );
    } else {
      base64 = encryptedValue;
    }
    const combined = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return decoder.decode(decrypted);
  }

  async function encrypt(text: string, key: CryptoKey): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, encoder.encode(text)
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  }

  const encryptionKey = await getKey(Deno.env.get("TOKEN_ENCRYPTION_KEY")!);
  const now = new Date();
  const expiresAt = provider.token_expires_at
    ? new Date(provider.token_expires_at as string) : null;

  // Use cached token if still valid with 5 minute buffer
  if (
    provider.access_token_encrypted &&
    expiresAt &&
    expiresAt > new Date(now.getTime() + 5 * 60 * 1000)
  ) {
    return await decrypt(provider.access_token_encrypted as string, encryptionKey);
  }

  // Refresh the token
  const refreshToken = await decrypt(
    provider.refresh_token_encrypted as string,
    encryptionKey
  );

  let tokenResponse: Response;

  if (providerType === "google") {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } else {
    tokenResponse = await fetch(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      {
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
      }
    );
  }

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    await supabase
      .schema("comms").from("email_providers")
      .update({ status: "expired", error_message: `Token refresh failed: ${err}` })
      .eq("id", provider.id);
    throw new Error(`Token refresh failed: ${err}`);
  }

  const tokens = await tokenResponse.json();
  const newExpiry = new Date(now.getTime() + tokens.expires_in * 1000);
  const encryptedNewAccess = await encrypt(tokens.access_token, encryptionKey);

  await supabase
    .schema("comms").from("email_providers")
    .update({
      access_token_encrypted: encryptedNewAccess,
      token_expires_at: newExpiry.toISOString(),
      status: "active",
      error_message: null,
    })
    .eq("id", provider.id);

  return tokens.access_token;
}

// ── Org notification sender (ported from handle-inbound-email) ───────────────
// Sends to active notification_recipients matching the event type, falling back
// to the connected provider inbox if none are configured.
async function sendOrgNotification(
  supabase: ReturnType<typeof createClient>,
  organizationId: string,
  eventType: "escalation" | "usage_limit" | "system",
  subject: string,
  body: string
): Promise<void> {
  const { data: provider } = await supabase
    .schema("comms").from("email_providers")
    .select("id, provider, provider_account_email, access_token_encrypted, refresh_token_encrypted, token_expires_at")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .maybeSingle();

  if (!provider) {
    console.warn(`No active provider for org ${organizationId} — cannot send ${eventType} notification`);
    return;
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

  let accessToken: string;
  try {
    accessToken = await getAccessToken(supabase, provider, provider.provider as "google" | "microsoft");
  } catch (e) {
    console.error(`Could not get access token for org ${organizationId}:`, e);
    return;
  }

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
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: encodedEmail }),
        });
        if (!res.ok) console.error(`Gmail send failed for ${toAddress}: ${await res.text()}`);
      } else if (provider.provider === "microsoft") {
        const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              subject,
              body: { contentType: "Text", content: body },
              toRecipients: [{ emailAddress: { address: toAddress.replace(/.*<(.+)>/, "$1") } }],
            },
            saveToSentItems: false,
          }),
        });
        if (!res.ok) console.error(`Graph send failed for ${toAddress}: ${await res.text()}`);
      }
    } catch (e) {
      console.error(`Failed to send ${eventType} notification to ${toAddress}:`, e);
    }
  }
}
