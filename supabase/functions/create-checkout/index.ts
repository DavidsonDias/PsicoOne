// PsicoOneX staging only. Test checkout does not grant subscription access.
const PROJECT = 'https://jeguvjpfuyksqiqrrvyz.supabase.co';
const APP = 'https://psicoone.vercel.app';
// Existing frontend price IDs are selectors only; never sent to Stripe.
const PLANS = new Map([
  ['price_1T9mRHAoMppjN4nr2UaJUpFD', { id: 'basic', product: 'prod_VJRCMaTkKJwey5', amount: 3900 }],
  ['price_1T9mRmAoMppjN4nrQUuyWzu9', { id: 'pro', product: 'prod_VJRDobs98Gd8d8', amount: 7900 }],
  ['price_1T9mSFAoMppjN4nrbsE6vHIW', { id: 'enterprise', product: 'prod_VJRDP4cdzq4dUb', amount: 14900 }],
]);
const headers = {
  'Access-Control-Allow-Origin': APP,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
};
const reply = (status, error, extra = {}) => new Response(JSON.stringify({ ...(error ? { error } : {}), ...extra }), { status, headers });
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply(405, 'Use POST.');
  const origin = req.headers.get('origin');
  if (origin && origin !== APP) return reply(403, 'Origem não permitida.');
  const authorization = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) return reply(401, 'Entre novamente para continuar.');
  const key = Deno.env.get('STRIPE_TEST_SECRET_KEY') || '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (Deno.env.get('SUPABASE_URL') !== PROJECT || !anon || !/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) {
    return reply(503, 'Checkout de teste não configurado.');
  }
  try {
    const auth = await fetch(`${PROJECT}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: authorization }, signal: AbortSignal.timeout(10000),
    });
    if (!auth.ok) return reply(auth.status >= 500 ? 503 : 401, 'Não foi possível validar sua sessão.');
    const user = await auth.json();
    if (!user.id || !user.email) return reply(401, 'Entre novamente para continuar.');
    let body;
    try { body = await req.json(); } catch { return reply(400, 'Pedido inválido.'); }
    const plan = PLANS.get(body?.priceId);
    if (!plan) return reply(400, 'Plano inválido.');
    const stripeHeaders = { Authorization: `Bearer ${key}`, 'Stripe-Version': '2025-08-27.basil' };
    const priceResponse = await fetch(`https://api.stripe.com/v1/prices?product=${plan.product}&active=true&type=recurring&limit=100`, {
      headers: stripeHeaders, signal: AbortSignal.timeout(15000),
    });
    if (!priceResponse.ok) return reply(502, 'Não foi possível consultar o plano de teste.');
    const prices = await priceResponse.json();
    const matches = (Array.isArray(prices.data) ? prices.data : []).filter(p =>
      p.livemode === false && p.active === true && p.product === plan.product &&
      p.currency === 'brl' && p.unit_amount === plan.amount && p.billing_scheme === 'per_unit' &&
      p.recurring?.interval === 'month' && p.recurring?.interval_count === 1 && p.recurring?.usage_type === 'licensed');
    if (prices.has_more || matches.length !== 1) return reply(503, 'Preço de teste ausente ou ambíguo.');
    const params = new URLSearchParams({
      mode: 'subscription', customer_email: user.email, client_reference_id: user.id,
      'line_items[0][price]': matches[0].id, 'line_items[0][quantity]': '1',
      'payment_method_types[0]': 'card',
      success_url: `${APP}/dashboard?checkout=test_completed`,
      cancel_url: `${APP}/dashboard?checkout=cancelled`,
      'metadata[user_id]': user.id, 'metadata[plan]': plan.id, 'metadata[environment]': 'staging_test',
      'subscription_data[metadata][user_id]': user.id, 'subscription_data[metadata][environment]': 'staging_test',
    });
    const result = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: { ...stripeHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(), signal: AbortSignal.timeout(15000),
    });
    if (!result.ok) return reply(502, 'Stripe não conseguiu abrir o checkout de teste.');
    const session = await result.json();
    if (session.livemode !== false || typeof session.id !== 'string' || !session.id.startsWith('cs_test_')) return reply(502, 'Resposta de teste inválida.');
    const checkout = new URL(session.url);
    if (checkout.protocol !== 'https:' || checkout.hostname !== 'checkout.stripe.com') return reply(502, 'Endereço de checkout inválido.');
    return reply(200, null, { url: checkout.href, test_mode: true });
  } catch {
    // Never log credentials, user details or raw provider responses.
    return reply(503, 'Checkout temporariamente indisponível. Tente novamente.');
  }
});
