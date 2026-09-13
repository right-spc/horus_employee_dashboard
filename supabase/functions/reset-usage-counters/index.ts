// ============================================
// EDGE FUNCTION: reset-usage-counters
// Cron: DAILY at 00:00 UTC
// Delegates to the DB function reset_pools_for_day(today's UTC day), which:
//   - resets each pool's used_this_month to 0 (monthly credits die; unused
//     do NOT roll over)
//   - leaves addon_credits untouched (never expire)
//   - logs billing.credit_cycle_history
//   - clears legacy org limit flags + messages_used_this_month
//   - re-enables widgets disabled with reason="usage_limit"
// Anchor: orgs whose subscription_end_date day-of-month (UTC) == today.
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

    // Skip days 29-31 — cycle anchor days are constrained to 1-28.
    if (day > 28) {
      console.log(`Day ${day} > 28, skipping reset.`);
      return new Response(
        JSON.stringify({ status: "ok", day, orgs_reset: 0, skipped: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const { data: orgsReset, error } = await supabase.rpc("reset_pools_for_day", {
      p_day: day,
    });

    if (error) {
      throw new Error(`reset_pools_for_day failed: ${error.message}`);
    }

    console.log(`Daily pool reset complete for day ${day}. Orgs reset: ${orgsReset}`);

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
