-- Proposal only. Apply to destination only after approval.
-- No provider tokens or clinical data are stored here.
create table public.google_calendar_oauth_attempts (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null check (redirect_uri in (
    'https://psicoonex.vercel.app/configuracoes',
    'https://psicoone.vercel.app/configuracoes'
  )),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes')
);
alter table public.google_calendar_oauth_attempts enable row level security;
revoke all on public.google_calendar_oauth_attempts from public, anon, authenticated;
grant select, insert, update, delete on public.google_calendar_oauth_attempts to service_role;

create function public.consume_google_calendar_oauth_attempt(
  p_state_hash text, p_user_id uuid, p_redirect_uri text
) returns boolean
language sql
security invoker
set search_path = ''
as $$
  with consumed as (
    update public.google_calendar_oauth_attempts
    set consumed_at = clock_timestamp()
    where state_hash = p_state_hash
      and user_id = p_user_id
      and redirect_uri = p_redirect_uri
      and consumed_at is null
      and expires_at > clock_timestamp()
    returning 1
  )
  select exists(select 1 from consumed);
$$;
revoke all on function public.consume_google_calendar_oauth_attempt(text, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_google_calendar_oauth_attempt(text, uuid, text) to service_role;

