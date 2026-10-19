-- Keep Google credentials server-only; preserve owner-scoped metadata access.
REVOKE ALL PRIVILEGES ON TABLE public.google_calendar_tokens FROM PUBLIC, anon, authenticated;
REVOKE SELECT (id,user_id,access_token,refresh_token,token_expires_at,google_email,calendar_id,sync_enabled,auto_create,auto_update,sync_new_only,created_at,updated_at),
 INSERT (id,user_id,access_token,refresh_token,token_expires_at,google_email,calendar_id,sync_enabled,auto_create,auto_update,sync_new_only,created_at,updated_at),
 UPDATE (id,user_id,access_token,refresh_token,token_expires_at,google_email,calendar_id,sync_enabled,auto_create,auto_update,sync_new_only,created_at,updated_at)
 ON public.google_calendar_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT (id,user_id,token_expires_at,google_email,calendar_id,sync_enabled,auto_create,auto_update,sync_new_only,created_at,updated_at)
 ON public.google_calendar_tokens TO authenticated;
GRANT UPDATE (sync_enabled,auto_create,auto_update,sync_new_only,updated_at)
 ON public.google_calendar_tokens TO authenticated;


