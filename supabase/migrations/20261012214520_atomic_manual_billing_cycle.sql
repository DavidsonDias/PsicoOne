-- preserve manual due-date selection, serialize writes with the worker.
CREATE OR REPLACE FUNCTION public.generate_manual_billing_cycle(
  p_plan_id uuid, p_expected_last_generated_at timestamptz, p_due_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  p public.patient_billing_plans%ROWTYPE;
  v_name text;
  v_id uuid;
  v_rows integer;
  v_label text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_due_date IS NULL OR NOT isfinite(p_due_date) THEN RAISE EXCEPTION 'Invalid due date'; END IF;
  SELECT * INTO p FROM public.patient_billing_plans
    WHERE id = p_plan_id AND psychologist_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan unavailable'; END IF;
  IF p.last_generated_at IS DISTINCT FROM p_expected_last_generated_at THEN
    RETURN jsonb_build_object('created', false, 'reason', 'stale_plan');
  END IF;
  IF NOT p.active OR p.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Plan unavailable'; END IF;
  SELECT full_name INTO v_name FROM public.patients
    WHERE id = p.patient_id AND psychologist_id = auth.uid() AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patient unavailable'; END IF;
  v_label := CASE p.billing_type WHEN 'monthly' THEN 'mensal' WHEN 'weekly' THEN 'semanal'
    WHEN 'biweekly' THEN 'quinzenal' WHEN 'per_session' THEN 'por sessão' END;
  IF v_label IS NULL THEN RAISE EXCEPTION 'Unsupported billing type'; END IF;
  INSERT INTO public.financial_transactions
    (psychologist_id,patient_id,billing_plan_id,type,status,amount,due_date,description,payment_method,category)
  VALUES (p.psychologist_id,p.patient_id,p.id,'income','pending',p.amount,p_due_date,
    coalesce(nullif(p.description,''),'Cobrança ' || v_label || ' — ' || coalesce(v_name,'Paciente')),
    coalesce(nullif(p.payment_method,''),'pix'),
    CASE WHEN p.billing_type='monthly' THEN 'Pacote mensal' ELSE 'Consulta psicológica' END)
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Billing insert was not persisted'; END IF;
  UPDATE public.patient_billing_plans SET last_generated_at=greatest(clock_timestamp(),p.last_generated_at+interval '1 microsecond') WHERE id=p.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN RAISE EXCEPTION 'Billing marker was not persisted'; END IF;
  RETURN jsonb_build_object('created',true,'transaction_id',v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.generate_manual_billing_cycle(uuid,timestamptz,date) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.generate_manual_billing_cycle(uuid,timestamptz,date) TO authenticated;


