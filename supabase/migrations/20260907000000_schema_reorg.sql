-- Schema reorganization: public (31 tables) -> 9 domain schemas
-- Executed 2026-09-07 via Supabase Management API. Recorded here for the repo.
-- Compat views in public keep pre-migration code working; drop them after all consumers are schema-qualified.

BEGIN;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS crm;
CREATE SCHEMA IF NOT EXISTS messaging;
CREATE SCHEMA IF NOT EXISTS kb;
CREATE SCHEMA IF NOT EXISTS business;
CREATE SCHEMA IF NOT EXISTS comms;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS system;

-- Grants (schema usage + future tables)
GRANT USAGE ON SCHEMA core TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA crm TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA messaging TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA messaging GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA kb TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA kb GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA business TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA business GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA comms TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA comms GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA billing TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA analytics TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT ALL ON TABLES TO service_role, authenticated, anon;
GRANT USAGE ON SCHEMA system TO service_role, authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA system GRANT ALL ON TABLES TO service_role, authenticated, anon;

-- -- core --
ALTER TABLE public.organizations SET SCHEMA core;
CREATE VIEW public.organizations WITH (security_invoker = true) AS SELECT * FROM core.organizations;
ALTER TABLE public.organization_members SET SCHEMA core;
CREATE VIEW public.organization_members WITH (security_invoker = true) AS SELECT * FROM core.organization_members;
ALTER TABLE public.dashboard_users SET SCHEMA core;
CREATE VIEW public.dashboard_users WITH (security_invoker = true) AS SELECT * FROM core.dashboard_users;
ALTER TABLE public.customer_users SET SCHEMA core;
CREATE VIEW public.customer_users WITH (security_invoker = true) AS SELECT * FROM core.customer_users;
ALTER TABLE public.widget_configs SET SCHEMA core;
CREATE VIEW public.widget_configs WITH (security_invoker = true) AS SELECT * FROM core.widget_configs;
ALTER TABLE public.demo_defaults SET SCHEMA core;
CREATE VIEW public.demo_defaults WITH (security_invoker = true) AS SELECT * FROM core.demo_defaults;

-- -- crm --
ALTER TABLE public.contacts SET SCHEMA crm;
CREATE VIEW public.contacts WITH (security_invoker = true) AS SELECT * FROM crm.contacts;
ALTER TABLE public.contact_aliases SET SCHEMA crm;
CREATE VIEW public.contact_aliases WITH (security_invoker = true) AS SELECT * FROM crm.contact_aliases;

-- -- messaging --
ALTER TABLE public.conversations SET SCHEMA messaging;
CREATE VIEW public.conversations WITH (security_invoker = true) AS SELECT * FROM messaging.conversations;
ALTER TABLE public.messages SET SCHEMA messaging;
CREATE VIEW public.messages WITH (security_invoker = true) AS SELECT * FROM messaging.messages;
ALTER TABLE public.conversation_merges SET SCHEMA messaging;
CREATE VIEW public.conversation_merges WITH (security_invoker = true) AS SELECT * FROM messaging.conversation_merges;
ALTER TABLE public.delivery_queue SET SCHEMA messaging;
CREATE VIEW public.delivery_queue WITH (security_invoker = true) AS SELECT * FROM messaging.delivery_queue;
ALTER TABLE public.widget_surveys SET SCHEMA messaging;
CREATE VIEW public.widget_surveys WITH (security_invoker = true) AS SELECT * FROM messaging.widget_surveys;

-- -- kb --
ALTER TABLE public.kb_documents SET SCHEMA kb;
CREATE VIEW public.kb_documents WITH (security_invoker = true) AS SELECT * FROM kb.kb_documents;
ALTER TABLE public.kb_chunks SET SCHEMA kb;
CREATE VIEW public.kb_chunks WITH (security_invoker = true) AS SELECT * FROM kb.kb_chunks;
ALTER TABLE public.kb_amend_requests SET SCHEMA kb;
CREATE VIEW public.kb_amend_requests WITH (security_invoker = true) AS SELECT * FROM kb.kb_amend_requests;

-- -- business --
ALTER TABLE public.business_profiles SET SCHEMA business;
CREATE VIEW public.business_profiles WITH (security_invoker = true) AS SELECT * FROM business.business_profiles;
ALTER TABLE public.business_services SET SCHEMA business;
CREATE VIEW public.business_services WITH (security_invoker = true) AS SELECT * FROM business.business_services;
ALTER TABLE public.business_hours SET SCHEMA business;
CREATE VIEW public.business_hours WITH (security_invoker = true) AS SELECT * FROM business.business_hours;
ALTER TABLE public.business_staff SET SCHEMA business;
CREATE VIEW public.business_staff WITH (security_invoker = true) AS SELECT * FROM business.business_staff;

-- -- comms --
ALTER TABLE public.email_providers SET SCHEMA comms;
CREATE VIEW public.email_providers WITH (security_invoker = true) AS SELECT * FROM comms.email_providers;
ALTER TABLE public.integrations SET SCHEMA comms;
CREATE VIEW public.integrations WITH (security_invoker = true) AS SELECT * FROM comms.integrations;
ALTER TABLE public.notification_recipients SET SCHEMA comms;
CREATE VIEW public.notification_recipients WITH (security_invoker = true) AS SELECT * FROM comms.notification_recipients;
ALTER TABLE public.export_schedules SET SCHEMA comms;
CREATE VIEW public.export_schedules WITH (security_invoker = true) AS SELECT * FROM comms.export_schedules;

-- -- billing --
ALTER TABLE public.payment_history SET SCHEMA billing;
CREATE VIEW public.payment_history WITH (security_invoker = true) AS SELECT * FROM billing.payment_history;
ALTER TABLE public.credit_cycle_history SET SCHEMA billing;
CREATE VIEW public.credit_cycle_history WITH (security_invoker = true) AS SELECT * FROM billing.credit_cycle_history;

-- -- analytics --
ALTER TABLE public.analytics_events SET SCHEMA analytics;
CREATE VIEW public.analytics_events WITH (security_invoker = true) AS SELECT * FROM analytics.analytics_events;
ALTER TABLE public.analytics_daily SET SCHEMA analytics;
CREATE VIEW public.analytics_daily WITH (security_invoker = true) AS SELECT * FROM analytics.analytics_daily;
ALTER TABLE public.analytics_hourly SET SCHEMA analytics;
CREATE VIEW public.analytics_hourly WITH (security_invoker = true) AS SELECT * FROM analytics.analytics_hourly;
ALTER TABLE public.audit_logs SET SCHEMA analytics;
CREATE VIEW public.audit_logs WITH (security_invoker = true) AS SELECT * FROM analytics.audit_logs;

-- -- system --
ALTER TABLE public.rate_limit_buckets SET SCHEMA system;
CREATE VIEW public.rate_limit_buckets WITH (security_invoker = true) AS SELECT * FROM system.rate_limit_buckets;

-- Compat views need explicit grants (default privileges did not cover them)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role, authenticated, anon;

-- PostgREST exposure (BOTH layers, then reload)
ALTER ROLE authenticator SET pgrst.db_schemas = 'public,storage,graphql_public,website,core,crm,messaging,kb,business,comms,billing,analytics,system';
-- Also PATCH /v1/projects/{ref}/postgrest {"db_schema": "<same list>"}
NOTIFY pgrst, 'reload schema';

COMMIT;

-- -- Follow-up steps executed same day --
-- 1. Bridge view for PostgREST cross-schema embeds (customer-api: conversations + contact:contacts(name)):
--    CREATE VIEW messaging.contacts WITH (security_invoker = true) AS SELECT * FROM crm.contacts;
-- 2. search_path set on 8 DB functions (increment_message_usage, is_usage_exceeded, increment_rate_limit_bucket,
--    recover_stale_delivery_jobs, reset_monthly_usage, reset_monthly_usage_for_day, update_conversation_timestamp,
--    validate_message_state_transition): SET search_path = public, core, crm, messaging, kb, business, comms, billing, analytics, system
-- 3. All 16 table-touching edge functions schema-qualified (.schema('x').from('y')) and redeployed
-- 4. Compat views dropped: DROP VIEW public.<all 31>; public schema now empty (0 tables, 0 views)
-- NOTE: messaging.contacts bridge view is PERMANENT infrastructure (not a compat view) — do not drop.

-- 5. Additional permanent bridge views (cross-schema FK embeds from core.organizations used by widget-chat + handle-inbound-email):
--    CREATE VIEW core.business_profiles / core.business_hours / core.business_services WITH (security_invoker=true) AS SELECT * FROM business.<same>;
--    (Same pattern as messaging.contacts. PostgREST only discovers relationships within the request schema.)
