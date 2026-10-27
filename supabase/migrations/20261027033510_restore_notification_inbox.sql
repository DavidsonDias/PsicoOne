CREATE OR REPLACE FUNCTION public.dispatch_notification_async(
  _user_id uuid, _category text, _type text, _title text, _message text,
  _action_path text DEFAULT NULL, _action_label text DEFAULT NULL, _metadata jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.notifications(user_id, category, type, title, message, action_path, action_label, metadata)
  VALUES (_user_id, _category, _type, _title, _message, _action_path, _action_label, _metadata);
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_notification_async(uuid,text,text,text,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_notification_async(uuid,text,text,text,text,text,text,jsonb) TO service_role;
