-- Atomic billing generation for the internal worker.
-- Called exclusively by the internal worker, once per plan.
CREATE OR REPLACE FUNCTION public.generate_patient_billing_cycle(p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  p public.patient_billing_plans%ROWTYPE;
  v_now timestamptz;
  v_today date;
  v_due date;
  v_day integer;
  v_transaction uuid;
  v_updated integer;
BEGIN
  SELECT * INTO p FROM public.patient_billing_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('created', false, 'reason', 'missing'); END IF;
  v_now := clock_timestamp();
  v_today := (v_now AT TIME ZONE 'UTC')::date;
  IF NOT p.active OR p.deleted_at IS NOT NULL OR p.start_date > v_today
     OR p.end_date < v_today THEN
    RETURN jsonb_build_object('created', false, 'reason', 'inactive');
  END IF;

  IF p.billing_type = 'monthly' THEN
    v_day := coalesce(nullif(p.day_of_month, 0), 1);
    IF v_day NOT BETWEEN 1 AND 31 THEN RAISE EXCEPTION 'Invalid billing day'; END IF;
    IF date_trunc('month', p.last_generated_at AT TIME ZONE 'UTC') = date_trunc('month', v_today::timestamp)
       OR extract(day FROM v_today) < v_day - 3 THEN
      RETURN jsonb_build_object('created', false, 'reason', 'not_due');
    END IF;
    -- Preserve the existing worker's overflow semantics for days 29-31.
    v_due := date_trunc('month', v_today::timestamp)::date + v_day - 1;
  ELSIF p.billing_type IN ('weekly', 'biweekly') THEN
    v_day := CASE WHEN p.billing_type = 'weekly' THEN 7 ELSE 14 END;
    IF p.last_generated_at IS NOT NULL AND v_now - p.last_generated_at < make_interval(hours => v_day * 24) THEN
      RETURN jsonb_build_object('created', false, 'reason', 'not_due');
    END IF;
    v_due := v_today + v_day;
  ELSE
    RETURN jsonb_build_object('created', false, 'reason', 'unsupported');
  END IF;

  PERFORM 1 FROM public.patients
    WHERE id = p.patient_id AND psychologist_id = p.psychologist_id AND deleted_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid billing patient relationship'; END IF;

  INSERT INTO public.financial_transactions
    (psychologist_id, patient_id, billing_plan_id, type, status, amount, due_date, description, payment_method, category)
  VALUES (p.psychologist_id, p.patient_id, p.id, 'income', 'pending', p.amount, v_due,
    coalesce(nullif(p.description, ''), 'Cobrança ' || p.billing_type), p.payment_method, 'session')
  RETURNING id INTO v_transaction;
  IF v_transaction IS NULL THEN RAISE EXCEPTION 'Billing insert was not persisted'; END IF;

  UPDATE public.patient_billing_plans SET last_generated_at = v_now WHERE id = p.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RAISE EXCEPTION 'Billing marker was not persisted'; END IF;
  RETURN jsonb_build_object('created', true, 'transaction_id', v_transaction);
END;
$$;
REVOKE ALL ON FUNCTION public.generate_patient_billing_cycle(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_patient_billing_cycle(uuid) TO service_role;

