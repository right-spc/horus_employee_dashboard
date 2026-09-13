-- Plan templates, intro pricing, SMS channel, number fee schedule (2026-09-18).
--
-- Owner decisions:
--   * Floor = cheapest plan's effective rate ($49.90/1k = Texting) — plan
--     prices always pass the guardrail; anything cheaper needs the override
--     permission. Overage stays $59/1k (premium one-off rate).
--   * Plans are ONE-CLICK TEMPLATES on the dynamic chassis (fill price +
--     intro + allowance + service activation); every field stays editable.
--     Templates live here as DATA (system.settings) — editable without deploy.
--   * Intro pricing is a schedule: intro_price_cents + intro_cycles_remaining,
--     decremented on each monthly renewal (extendSubscription); customizable
--     per org. Guardrails in dashboard-api: intro <= standard, cycles <= 12.
--   * Number fees: toll-free/1-800 one-time fees INCLUDE verification;
--     10DLC reduced to $150 one-time (local-number SMS only; toll-free SMS
--     uses free toll-free verification).
--   * Voice burn by number type: local 10 cr/min, toll-free 12 cr/min —
--     order_phone_number sets the voice row's credit_cost at provisioning.
--   * SMS reply = 3 credits; sms service rows seeded disabled (CHECK already
--     allowed 'sms').

BEGIN;

-- Floor: cheapest plan effective rate
UPDATE system.settings
   SET value = '4990'::jsonb, updated_at = now()
 WHERE key = 'price_per_1000_credits_cents';

-- Plan templates + number fee schedule (data, not code)
INSERT INTO system.settings (key, value) VALUES
  ('plan_templates', '[
    {"key":"texting","label":"Texting","monthly_price_cents":49900,"intro_price_cents":29900,"intro_cycles":3,"monthly_credits":10000,"services":["webchat","email","sms"]},
    {"key":"texting_voice","label":"Texting + Voice","monthly_price_cents":129900,"intro_price_cents":99900,"intro_cycles":3,"monthly_credits":25000,"services":["webchat","email","sms","voice"]}
  ]'::jsonb),
  ('number_fees', '{
    "local":     {"one_time_cents":0,     "monthly_cents":0,    "label":"Local number",        "note":"included"},
    "tollfree":  {"one_time_cents":30000, "monthly_cents":5000, "label":"Toll-free number",    "note":"includes toll-free verification"},
    "vanity800": {"one_time_cents":100000,"monthly_cents":10000,"label":"1-800 number",        "note":"includes toll-free verification"},
    "dlc_10":    {"one_time_cents":15000, "monthly_cents":0,    "label":"10DLC registration",  "note":"required for SMS on local numbers"}
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Intro pricing schedule
ALTER TABLE core.organizations
  ADD COLUMN IF NOT EXISTS intro_price_cents integer CHECK (intro_price_cents >= 0),
  ADD COLUMN IF NOT EXISTS intro_cycles_remaining integer NOT NULL DEFAULT 0 CHECK (intro_cycles_remaining >= 0);

-- SMS service rows (3 credits/reply, disabled) for real orgs
INSERT INTO core.org_services (organization_id, service, enabled, usage_pool, credit_cost)
SELECT o.id, 'sms', false, 'credits', 3
FROM core.organizations o
WHERE o.is_demo = false
ON CONFLICT (organization_id, service) DO NOTHING;

COMMIT;
