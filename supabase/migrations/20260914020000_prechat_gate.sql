-- Pre-chat gate: client-written disclaimer the visitor must accept before
-- chatting. Markdown-style links [label](https://url) are rendered by the
-- widget. Acceptance is stamped on the conversation as proof.
alter table core.widget_configs
  add column if not exists disclaimer_enabled boolean not null default false,
  add column if not exists disclaimer_text text not null default '';

alter table messaging.conversations
  add column if not exists consent_accepted_at timestamptz,
  add column if not exists consent_version text;
