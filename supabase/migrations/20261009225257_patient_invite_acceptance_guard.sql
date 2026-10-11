-- Bind the authenticated recipient exactly once; serialize invite and patient.
create or replace function public.accept_patient_invite(_token text, _user_id uuid)
returns uuid language plpgsql security definer set search_path = public
as $function$
declare
  v_invite public.patient_invites%rowtype;
  v_patient public.patients%rowtype;
  v_linked uuid;
begin
  if auth.uid() is null or _user_id is distinct from auth.uid() then
    raise exception 'Identity mismatch' using errcode='42501';
  end if;
  select * into v_invite from public.patient_invites
  where token=_token and not is_revoked and accepted_at is null and expires_at>now()
  for update;
  if not found then raise exception 'Convite inválido ou expirado' using errcode='22023'; end if;
  select * into v_patient from public.patients where id=v_invite.patient_id for update;
  if not found or v_patient.deleted_at is not null
    or v_patient.psychologist_id is distinct from v_invite.psychologist_id
    or (v_patient.user_id is not null and v_patient.user_id is distinct from _user_id) then
    raise exception 'Convite indisponível' using errcode='22023';
  end if;
  if not exists(select 1 from auth.users u where u.id=_user_id
    and u.email_confirmed_at is not null
    and lower(btrim(u.email))=lower(btrim(v_invite.email))) then
    raise exception 'Entre com a conta de email confirmada que recebeu o convite' using errcode='42501';
  end if;
  update public.patients set user_id=_user_id,
    portal_activated_at=coalesce(portal_activated_at,now())
  where id=v_patient.id returning user_id into v_linked;
  if not found or v_linked is distinct from _user_id then
    raise exception 'Não foi possível vincular a conta' using errcode='22023';
  end if;
  update public.patient_invites set accepted_at=now(),accepted_user_id=_user_id where id=v_invite.id;
  insert into public.user_roles(user_id,role) values(_user_id,'patient') on conflict do nothing;
  insert into public.patient_portal_audit(patient_id,user_id,action,metadata)
  values(v_patient.id,_user_id,'portal_activated',jsonb_build_object('via','invite'));
  return v_patient.id;
end;
$function$;
revoke all on function public.accept_patient_invite(text,uuid) from public,anon;
grant execute on function public.accept_patient_invite(text,uuid) to authenticated;

-- RLS controls which row may be updated. A patient may change only preferences.
-- Check OLD ownership: accepting an unlinked invite must not undo the new link.
create or replace function public.enforce_patient_self_update_columns()
returns trigger language plpgsql security definer set search_path=public
as $function$
declare v_channel text:=new.preferred_notification_channel; v_phone text:=new.whatsapp_phone;
begin
  if auth.uid() is null or old.user_id is distinct from auth.uid() then return new; end if;
  if auth.uid()=old.psychologist_id or public.has_role(auth.uid(),'super_admin'::public.app_role) then return new; end if;
  new:=old;
  new.preferred_notification_channel:=v_channel;
  new.whatsapp_phone:=v_phone;
  new.updated_at:=now();
  return new;
end;
$function$;
