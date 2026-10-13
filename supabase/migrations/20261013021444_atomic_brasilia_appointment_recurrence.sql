-- fixed Brasilia calendar, no changes to existing appointments.
CREATE OR REPLACE FUNCTION public.recurrence_dates_brasilia(
  p_anchor timestamptz, p_type text, p_after date, p_until date
) RETURNS SETOF timestamptz LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=''
AS $$
DECLARE
  a timestamp := p_anchor AT TIME ZONE 'America/Sao_Paulo';
  n integer;
  first_n integer;
  last_n integer;
  days integer;
  candidate timestamp;
BEGIN
  IF p_anchor IS NULL OR p_after IS NULL OR p_until IS NULL OR p_until<=p_after THEN RETURN; END IF;
  IF p_type='monthly' THEN
    first_n:=greatest(1,(extract(year FROM p_after)::int-extract(year FROM a)::int)*12+extract(month FROM p_after)::int-extract(month FROM a)::int);
    last_n:=(extract(year FROM p_until)::int-extract(year FROM a)::int)*12+extract(month FROM p_until)::int-extract(month FROM a)::int;
  ELSIF p_type IN ('weekly','biweekly') THEN
    days:=CASE WHEN p_type='weekly' THEN 7 ELSE 14 END;
    first_n:=greatest(1,(p_after-a::date)/days);
    last_n:=(p_until-a::date)/days;
  ELSE RAISE EXCEPTION 'Unsupported recurrence type'; END IF;
  FOR n IN first_n..last_n LOOP
    candidate:=CASE WHEN p_type='monthly' THEN a+make_interval(months=>n) ELSE a+make_interval(days=>n*days) END;
    IF candidate::date>p_after AND candidate::date<=p_until THEN
      RETURN NEXT candidate AT TIME ZONE 'America/Sao_Paulo';
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.recurrence_dates_brasilia(timestamptz,text,date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recurrence_dates_brasilia(timestamptz,text,date,date) TO service_role;

CREATE OR REPLACE FUNCTION public.extend_appointment_recurrence(p_parent_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=''
AS $$
DECLARE
  p public.appointments%ROWTYPE;
  today date := (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date;
  horizon date;
  after_date date;
  slot timestamptz;
  inserted_id uuid;
  created integer:=0;
  rows_updated integer;
BEGIN
  SELECT * INTO p FROM public.appointments WHERE id=p_parent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('created',0,'reason','missing'); END IF;
  IF NOT p.recurrence_open_ended OR p.deleted_at IS NOT NULL OR p.recurrence_parent_id IS NOT NULL THEN
    RETURN jsonb_build_object('created',0,'reason','inactive');
  END IF;
  horizon:=least(today+90,coalesce(p.recurrence_end_date,today+90));
  after_date:=greatest(coalesce(p.recurrence_extended_until,(p.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date),today);
  IF after_date>=horizon THEN RETURN jsonb_build_object('created',0,'reason','covered'); END IF;
  PERFORM 1 FROM public.patients WHERE id=p.patient_id AND psychologist_id=p.psychologist_id AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recurrence patient relationship'; END IF;
  FOR slot IN SELECT * FROM public.recurrence_dates_brasilia(p.scheduled_at,p.recurrence_type,after_date,horizon) LOOP
    -- Existing, cancelled or soft-deleted slots must not be recreated.
    IF EXISTS(SELECT 1 FROM public.appointments WHERE recurrence_parent_id=p.id AND scheduled_at=slot) THEN CONTINUE; END IF;
    INSERT INTO public.appointments(psychologist_id,patient_id,scheduled_at,duration_minutes,type,status,notes,session_value,recurrence_parent_id,recurrence_type)
      VALUES(p.psychologist_id,p.patient_id,slot,p.duration_minutes,p.type,'scheduled',p.notes,p.session_value,p.id,p.recurrence_type)
      RETURNING id INTO inserted_id;
    IF inserted_id IS NULL THEN RAISE EXCEPTION 'Recurrence insert was not persisted'; END IF;
    created:=created+1;
  END LOOP;
  UPDATE public.appointments SET recurrence_extended_until=horizon WHERE id=p.id;
  GET DIAGNOSTICS rows_updated=ROW_COUNT;
  IF rows_updated<>1 THEN RAISE EXCEPTION 'Recurrence marker was not persisted'; END IF;
  RETURN jsonb_build_object('created',created,'extended_until',horizon);
END;
$$;
REVOKE ALL ON FUNCTION public.extend_appointment_recurrence(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.extend_appointment_recurrence(uuid) TO service_role;

