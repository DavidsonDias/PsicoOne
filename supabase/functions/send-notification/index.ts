import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // Server-to-server only (cron + trusted server callers).
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
    || req.headers.get("x-internal-secret");
  const allowed = new Set(
    [
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      Deno.env.get("INTERNAL_FUNCTION_SECRET"),
      Deno.env.get("CRON_SECRET"),
    ].filter(Boolean) as string[],
  );
  if (!token || !allowed.has(token)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }


  try {
    const body = await req.json();
    const { type } = body;

    // Process automation rules
    if (type === 'process-automations') {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, serviceKey);

      const { data: rules } = await supabase
        .from('automation_rules')
        .select('*')
        .eq('is_active', true);

      if (!rules || rules.length === 0) {
        return new Response(JSON.stringify({ processed: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      let processed = 0;
      const now = new Date();

      for (const rule of rules) {
        const userId = rule.psychologist_id;

        if (rule.trigger_type === 'overdue_payment') {
          const { data: overdue } = await supabase
            .from('financial_transactions')
            .select('id, amount, patient_id')
            .eq('psychologist_id', userId)
            .eq('status', 'pending')
            .eq('type', 'income')
            .is('deleted_at', null)
            .lt('due_date', now.toISOString().split('T')[0]);

          if (overdue && overdue.length > 0) {
            const total = overdue.reduce((s: number, t: any) => s + Number(t.amount), 0);
            await supabase.from('notifications').insert({
              user_id: userId,
              type: 'financial',
              title: `${overdue.length} pagamento(s) atrasado(s)`,
              message: `Total de R$ ${total.toFixed(2)} em atraso.`,
              action_label: 'Ver financeiro',
              action_path: '/financeiro',
            });
            await supabase.from('automation_rules').update({
              last_triggered_at: now.toISOString(),
              trigger_count: rule.trigger_count + 1,
            }).eq('id', rule.id);
            processed++;
          }
        }

        if (rule.trigger_type === 'missed_appointment') {
          const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000);
          const { data: patients } = await supabase
            .from('patients')
            .select('id, full_name')
            .eq('psychologist_id', userId)
            .eq('status', 'active')
            .is('deleted_at', null);

          if (patients && patients.length > 0) {
            const { data: recentApts } = await supabase
              .from('appointments')
              .select('patient_id')
              .eq('psychologist_id', userId)
              .is('deleted_at', null)
              .gte('scheduled_at', fourteenDaysAgo.toISOString());

            const recentSet = new Set((recentApts || []).map(a => a.patient_id));
            const inactive = patients.filter(p => !recentSet.has(p.id));

            if (inactive.length > 0) {
              await supabase.from('notifications').insert({
                user_id: userId,
                type: 'clinical',
                title: `${inactive.length} paciente(s) sem sessão recente`,
                message: `Pacientes sem sessão há +14 dias: ${inactive.slice(0, 3).map(p => p.full_name).join(', ')}`,
                action_label: 'Ver pacientes',
                action_path: '/pacientes',
              });
              await supabase.from('automation_rules').update({
                last_triggered_at: now.toISOString(),
                trigger_count: rule.trigger_count + 1,
              }).eq('id', rule.id);
              processed++;
            }
          }
        }

        if (rule.trigger_type === 'session_reminder') {
          const twoHoursFromNow = new Date(now.getTime() + 2 * 3600000);
          const { data: upcoming } = await supabase
            .from('appointments')
            .select('id, scheduled_at, patient_id, patients(full_name)')
            .eq('psychologist_id', userId)
            .eq('status', 'scheduled')
            .eq('reminder_sent', false)
            .is('deleted_at', null)
            .gte('scheduled_at', now.toISOString())
            .lte('scheduled_at', twoHoursFromNow.toISOString());

          if (upcoming && upcoming.length > 0) {
            for (const apt of upcoming) {
              const pName = (apt as any).patients?.full_name || 'Paciente';
              await supabase.from('notifications').insert({
                user_id: userId,
                type: 'reminder',
                title: `Sessão em breve: ${pName}`,
                message: `Agendada para ${new Date(apt.scheduled_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`,
                action_label: 'Ver agenda',
                action_path: '/agenda',
              });
              await supabase.from('appointments').update({ reminder_sent: true }).eq('id', apt.id);
            }
            await supabase.from('automation_rules').update({
              last_triggered_at: now.toISOString(),
              trigger_count: rule.trigger_count + 1,
            }).eq('id', rule.id);
            processed++;
          }
        }
      }

      return new Response(JSON.stringify({ processed }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // No email transport exists on this path. Never acknowledge delivery.
    const { to, subject, message } = body;
    if (!to || !subject || !message) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: false, sent: false, code: 'EMAIL_TRANSPORT_UNAVAILABLE', error: 'Envio de email indisponível nesta função.' }), {
      status: 501,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('send-notification error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
