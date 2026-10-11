-- Run as database administrator; only synthetic patients/invites, always rollback.
begin;
do $setup$
declare u record; owner_id uuid; pid uuid:=gen_random_uuid(); other_id uuid; tok text:=encode(extensions.gen_random_bytes(32),'hex');
begin
 select id,email into u from auth.users where email_confirmed_at is not null
 and not public.has_role(id,'super_admin'::public.app_role) limit 1;
 select id into owner_id from auth.users where id<>u.id limit 1;
 select id into other_id from auth.users where id<>u.id and id<>owner_id limit 1;
 if u.id is null or owner_id is null or other_id is null then raise exception 'Missing fixtures'; end if;
 insert into public.patients(id,psychologist_id,full_name) values(pid,owner_id,'Synthetic invite regression');
 insert into public.patient_invites(patient_id,psychologist_id,email,token) values(pid,owner_id,u.email,tok);
 perform set_config('audit.accept_context',jsonb_build_object('user',u.id,'owner',owner_id,'other',other_id,'patient',pid,'token',tok)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u.id,'role','authenticated')::text,true);
end $setup$;
set local role authenticated;
do $test$
declare c jsonb:=current_setting('audit.accept_context')::jsonb; p public.patients%rowtype; result uuid;
begin
 begin
 perform public.accept_patient_invite(c->>'token',(c->>'other')::uuid);
 raise exception 'Identity substitution accepted';
 exception when insufficient_privilege then null; end;
 result:=public.accept_patient_invite(c->>'token',(c->>'user')::uuid);
 if result is distinct from (c->>'patient')::uuid then raise exception 'Acceptance failed'; end if;
 select * into p from public.patients where id=result;
 if p.user_id is distinct from (c->>'user')::uuid or p.portal_activated_at is null then raise exception 'Link not persisted'; end if;
 begin
 perform public.accept_patient_invite(c->>'token',(c->>'user')::uuid);
 raise exception 'Invite reused';
 exception when invalid_parameter_value then null; end;
 update public.patients set preferred_notification_channel='none',whatsapp_phone='synthetic',
 full_name='Unauthorized',notes='Unauthorized',user_id=(c->>'other')::uuid,deleted_at=now()
 where id=result;
 select * into p from public.patients where id=result;
 if p.full_name<>'Synthetic invite regression' or p.notes is not null or p.deleted_at is not null
 or p.user_id is distinct from (c->>'user')::uuid or p.preferred_notification_channel<>'none'
 or p.whatsapp_phone<>'synthetic' then raise exception 'Patient column guard failed'; end if;
end $test$;
reset role;
do $negative_setup$
declare c jsonb:=current_setting('audit.accept_context')::jsonb; t text; pid uuid; scenario text; uemail text;
begin
 select email into uemail from auth.users where id=(c->>'user')::uuid;
 foreach scenario in array array['linked','deleted','owner_mismatch','email_mismatch','revoked','expired'] loop
 pid:=gen_random_uuid(); t:=encode(extensions.gen_random_bytes(32),'hex');
 -- Administrative fixture, avoid acting as a patient while preparing.
 perform set_config('request.jwt.claims','{}',true);
 insert into public.patients(id,psychologist_id,full_name,user_id,deleted_at)
 values(pid,(c->>'owner')::uuid,'Synthetic rejection',
 case when scenario='linked' then (c->>'other')::uuid else null end,
 case when scenario='deleted' then now() else null end);
 insert into public.patient_invites(patient_id,psychologist_id,email,token,is_revoked,expires_at)
 values(pid,case when scenario='owner_mismatch' then (c->>'other')::uuid else (c->>'owner')::uuid end,
 case when scenario='email_mismatch' then 'nobody@example.invalid' else uemail end,t,scenario='revoked',
 case when scenario='expired' then now()-interval '1 day' else now()+interval '1 day' end);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',c->>'user','role','authenticated')::text,true);
 begin
 perform public.accept_patient_invite(t,(c->>'user')::uuid);
 raise exception 'Negative case accepted: %',scenario;
 exception when invalid_parameter_value or insufficient_privilege then null; end;
 if exists(select 1 from public.patient_invites where token=t and accepted_at is not null) then raise exception 'Rejected invite consumed'; end if;
 end loop;
end $negative_setup$;
rollback;
