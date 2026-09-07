// ============================================
// EDGE FUNCTION: reset-usage-counters
// Cron: DAILY at 00:00 UTC
// For each org whose cycle_anchor_day matches today's UTC day:
//   - rolls leftover monthly credits into rollover_credits
//     (any prior rollover is discarded — "only once" rule)
//   - refills monthly_credits_remaining = message_limit_per_month
//   - leaves addon_credits untouched
//   - clears messages_used_this_month + limit flags
// Then re-enables widgets that were disabled with reason="usage_limit"
// for any of those orgs.
//
// NOTE: cycle_anchor_day is the day the effective service period rolls
// over. It is set at org creation and does NOT change when the customer
// moves their billing/payment-due date (billing_day_of_month).
// ============================================

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const day = new Date().getUTCDate();

    // Skip days 29-31 — billing_day_of_month is constrained to 1-28.
    if (day > 28) {
      console.log(`Day ${day} > 28, skipping reset.`);
      return new Response(
        JSON.stringify({ status: "ok", day, orgs_reset: 0, skipped: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: orgsReset, error } = await supabase.rpc("reset_monthly_usage_for_day", {
      p_day: day,
    });

    if (error) {
      throw new Error(`reset_monthly_usage_for_day failed: ${error.message}`);
    }

    console.log(`Daily reset complete for day ${day}. Orgs reset: ${orgsReset}`);

    // Re-enable widgets that had been disabled due to usage_limit, scoped to
    // the orgs whose cycle anchor day is today (i.e. their new effective
    // period just started).
    const { data: orgIds } = await supabase
      .from("organizations")
      .select("id")
      .eq("cycle_anchor_day", day);

    if (orgIds && orgIds.length > 0) {
      const ids = orgIds.map((o: { id: string }) => o.id);
      await supabase
        .from("widget_configs")
        .update({ enabled: true, disable_reason: null, disable_message: null })
        .in("organization_id", ids)
        .eq("disable_reason", "usage_limit");
    }

    return new Response(
      JSON.stringify({ status: "ok", day, orgs_reset: orgsReset }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("reset-usage-counters error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
