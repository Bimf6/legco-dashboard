create table if not exists meetings (
  meet_id bigint primary key,
  slot_id text,
  committee_code text,
  committee_name_en text,
  committee_name_tc text,
  subject_en text not null,
  subject_tc text not null,
  start_date_time text not null,
  venue_code text,
  venue_name_en text,
  venue_name_tc text,
  meeting_type_en text,
  meeting_type_tc text,
  agenda_url_en text,
  agenda_url_tc text,
  home_url_en text,
  agenda_http_status integer not null default 0,
  agenda_hash text,
  agenda_items_json jsonb not null default '[]'::jsonb,
  is_live boolean not null default false,
  webcast_url text,
  cancelled boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_meetings_start_date_time on meetings (start_date_time);

create table if not exists meeting_change_events (
  id bigserial primary key,
  meet_id bigint,
  event_type text not null,
  severity text not null default 'normal',
  title_en text not null,
  title_tc text not null,
  summary_en text not null,
  summary_tc text not null,
  old_value text,
  new_value text,
  link_url text,
  committee_name_en text,
  committee_name_tc text,
  detected_at timestamptz not null default now(),
  fingerprint text unique not null
);

create index if not exists idx_meeting_change_events_detected_at on meeting_change_events (detected_at desc);

create table if not exists documents (
  id bigserial primary key,
  doc_key text unique not null,
  paper_no text,
  doc_type text not null,
  source_kind text not null,
  committee_name_en text,
  committee_name_tc text,
  title_en text not null,
  title_tc text not null,
  summary_en text,
  summary_tc text,
  url_en text,
  url_tc text,
  meeting_date text,
  issue_date text,
  reply_to_paper_no text,
  related_paper_no text,
  meet_id bigint,
  published_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now()
);

create index if not exists idx_documents_published_at on documents (published_at desc);
create index if not exists idx_documents_doc_type on documents (doc_type);
create index if not exists idx_documents_paper_no on documents (paper_no);

create table if not exists questions (
  id bigserial primary key,
  question_key text unique not null,
  stage text not null,
  question_type text not null,
  question_no integer,
  meeting_date text not null,
  member_name_en text not null,
  member_name_tc text not null,
  subject_en text not null,
  subject_tc text not null,
  body_en text,
  body_tc text,
  agenda_url_en text,
  agenda_url_tc text,
  hansard_url_en text,
  hansard_url_tc text,
  reply_url_en text,
  reply_url_tc text,
  content_hash text,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_questions_meeting_date on questions (meeting_date desc);
create index if not exists idx_questions_stage on questions (stage);

create table if not exists watchlist_rules (
  id bigserial primary key,
  viewer_sub text not null,
  rule_type text not null,
  value text not null,
  label text not null,
  created_at timestamptz not null default now(),
  unique (viewer_sub, rule_type, value)
);

create table if not exists sync_state (
  id integer primary key default 1,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_mode text,
  last_summary_json jsonb not null default '{}'::jsonb,
  last_error text,
  is_syncing boolean not null default false
);

insert into sync_state (id) values (1) on conflict (id) do nothing;

create table if not exists viewer_ack_state (
  viewer_sub text primary key,
  last_ack_at timestamptz not null default now()
);
