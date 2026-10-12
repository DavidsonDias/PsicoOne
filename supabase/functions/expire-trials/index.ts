import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Restrict to trusted internal callers (cron / service role / super admin secret).
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
    || req.headers.get("x-cron-secret")
    || req.headers.get("x-internal-secret");
  const allowed = new Set(
    [
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
      Deno.env.get("INTERNAL_FUNCTION_SECRET"),
      Deno.env.get("CRON_SECRET"),
    ].filter(Boolean) as string[],
  );
  if (!token || !allowed.has(token)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Find all trial subscriptions where trial_end_date has passed
    const now = new Date().toISOString();
    const { data: expiredTrials, error: fetchError } = await supabase
      .from("subscriptions")
      .select("id, user_id, trial_end_date")
      .eq("status", "trial")
      .lt("trial_end_date", now);

    if (fetchError) {
      throw fetchError;
    }

    if (!expiredTrials || expiredTrials.length === 0) {
      console.log("No expired trials found.");
      return new Response(
        JSON.stringify({ message: "No expired trials", count: 0 }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${expiredTrials.length} expired trial(s). Processing...`);

    let expiredCount = 0;

    for (const trial of expiredTrials) {
      // Update status to expired
      const { data: updated, error: updateError } = await supabase
        .from("subscriptions")
        .update({
          status: "expired",
          updated_at: now,
        })
        .eq("id", trial.id)
        .eq("status", "trial")
        .eq("trial_end_date", trial.trial_end_date)
        .lt("trial_end_date", now)
        .select("id");

      if (updateError) {
        console.error(`Failed to expire trial ${trial.id}:`, updateError);
        continue;
      }
      // Another request may have extended, activated or already expired it.
      if (!updated?.length) continue;

      // Log the action in audit_logs
      await supabase.from("audit_logs").insert({
        user_id: trial.user_id,
        action_type: "auto_expire_trial",
        entity_type: "subscription",
        entity_id: trial.id,
        new_data: { status: "expired", expired_at: now },
      });

      expiredCount++;
      console.log(`Expired trial for user ${trial.user_id}`);
    }

    return new Response(
      JSON.stringify({
        message: `Expired ${expiredCount} trial(s)`,
        count: expiredCount,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in expire-trials:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
