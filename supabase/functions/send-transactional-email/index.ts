import * as React from 'npm:react@18.3.1'
import { renderAsync } from 'npm:@react-email/components@0.0.22'
import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { TEMPLATES } from '../_shared/transactional-email-templates/registry.ts'

// STAGING ONLY: authenticated manual enqueue; worker is invoked separately.
const STAGING_URL = 'https://jeguvjpfuyksqiqrrvyz.supabase.co'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://psicoone.vercel.app',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-email-worker-secret',
}

// Generate a cryptographically random 32-byte hex token
function generateToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Authenticate every POST with the dedicated secret before database access.
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing required environment variables')
    return new Response(
      JSON.stringify({ error: 'Server configuration error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
  if (req.method !== 'POST') return respond(405, { error: 'POST required' })
  const workerSecret = Deno.env.get('EMAIL_WORKER_SECRET')
  const testRecipient = Deno.env.get('EMAIL_TEST_RECIPIENT')?.trim().toLowerCase()
  const emailFrom = Deno.env.get('EMAIL_FROM')?.trim()
  if (supabaseUrl.replace(/\/$/, '') !== STAGING_URL || !workerSecret || workerSecret.length < 32 ||
      !testRecipient || !/^[^\s<>;,]+@[^\s<>;,]+\.[^\s<>;,]+$/.test(testRecipient) ||
      !emailFrom || !/^(?:[^<>\r\n]+\s*<)?noreply@psicoone-mail\.sevendevx\.com>?$/.test(emailFrom)) {
    return respond(503, { error: 'Invalid staging configuration' })
  }
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  const [provided, expected] = await Promise.all([
    digest(req.headers.get('x-email-worker-secret') || ''), digest(workerSecret),
  ])
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) mismatch |= provided[i] ^ expected[i]
  if (mismatch) return respond(401, { error: 'Worker secret required' })

  // Parse request body
  let immediate = false
  let templateName: string
  let recipientEmail: string
  let idempotencyKey: string
  let messageId: string
  let templateData: Record<string, any> = {}
  let externalMetadata: Record<string, any> | undefined
  try {
    const body = await req.json()
    immediate = body.delivery === "immediate"
    templateName = body.templateName || body.template_name
    recipientEmail = body.recipientEmail || body.recipient_email
    messageId = crypto.randomUUID()
    idempotencyKey = body.idempotencyKey || body.idempotency_key || messageId
    if (body.templateData && typeof body.templateData === 'object') {
      templateData = body.templateData
    }
    if (body.metadata && typeof body.metadata === 'object') {
      externalMetadata = body.metadata
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || new TextEncoder().encode(idempotencyKey).length > 512) {
    return respond(400, { error: 'Invalid idempotency key' })
  }

  if (!templateName) {
    return new Response(
      JSON.stringify({ error: 'templateName is required' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 1. Look up template from registry (early — needed to resolve recipient)
  const template = Object.hasOwn(TEMPLATES, templateName) ? TEMPLATES[templateName] : undefined

  if (!template) {
    console.error('Template not found in registry', { templateName })
    return new Response(
      JSON.stringify({
        error: `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(', ')}`,
      }),
      {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // Resolve effective recipient: template-level `to` takes precedence over
  // the caller-provided recipientEmail. This allows notification templates
  // to always send to a fixed address (e.g., site owner from env var).
  const effectiveRecipient = template.to || recipientEmail

  if (!effectiveRecipient) {
    return new Response(
      JSON.stringify({
        error: 'recipientEmail is required (unless the template defines a fixed recipient)',
      }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (immediate && !['appointment-confirmation', 'patient-portal-invite'].includes(templateName)) return respond(400, { error: 'Unsupported immediate template' })
  if (typeof effectiveRecipient !== 'string' || !/^[^\s<>;,]+@[^\s<>;,]+\.[^\s<>;,]+$/.test(effectiveRecipient) || (!immediate && effectiveRecipient.trim().toLowerCase() !== testRecipient)) {
    return respond(403, { error: 'Recipient blocked by staging allowlist' })
  }
  // Template buttons must remain inside staging. Never rewrite real-user links.
  for (const field of ['portalUrl', 'inviteUrl', 'agendaUrl']) {
    if (templateData[field] !== undefined && templateData[field] !== '') {
      try {
        const link = new URL(templateData[field])
        if (link.origin !== 'https://psicoone.vercel.app' || link.username || link.password) throw new Error()
      } catch {
        return respond(400, { error: 'Template links must use the staging site', field })
      }
    }
  }

  // Create Supabase client with service role (bypasses RLS)
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // 2. Check suppression list (fail-closed: if we can't verify, don't send)
  const { data: suppressed, error: suppressionError } = await supabase
    .from('suppressed_emails')
    .select('id')
    .eq('email', effectiveRecipient.toLowerCase())
    .maybeSingle()

  if (suppressionError) {
    console.error('Suppression check failed — refusing to send', {
      error: suppressionError,
      effectiveRecipient,
    })
    return new Response(
      JSON.stringify({ error: 'Failed to verify suppression status' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (suppressed) {
    // Log the suppressed attempt
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
    })

    console.log('Email suppressed', { effectiveRecipient, templateName })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 3. Get or create unsubscribe token (one token per email address)
  const normalizedEmail = effectiveRecipient.toLowerCase()
  let unsubscribeToken: string

  // Check for existing token for this email
  const { data: existingToken, error: tokenLookupError } = await supabase
    .from('email_unsubscribe_tokens')
    .select('token, used_at')
    .eq('email', normalizedEmail)
    .maybeSingle()

  if (tokenLookupError) {
    console.error('Token lookup failed', {
      error: tokenLookupError,
      email: normalizedEmail,
    })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'failed',
      error_message: 'Failed to look up unsubscribe token',
    })
    return new Response(
      JSON.stringify({ error: 'Failed to prepare email' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  if (existingToken && !existingToken.used_at) {
    // Reuse existing unused token
    unsubscribeToken = existingToken.token
  } else if (!existingToken) {
    // Create new token — upsert handles concurrent inserts gracefully
    unsubscribeToken = generateToken()
    const { error: tokenError } = await supabase
      .from('email_unsubscribe_tokens')
      .upsert(
        { token: unsubscribeToken, email: normalizedEmail },
        { onConflict: 'email', ignoreDuplicates: true }
      )

    if (tokenError) {
      console.error('Failed to create unsubscribe token', {
        error: tokenError,
      })
      await supabase.from('email_send_log').insert({
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Failed to create unsubscribe token',
      })
      return new Response(
        JSON.stringify({ error: 'Failed to prepare email' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // If another request raced us, our upsert was silently ignored.
    // Re-read to get the actual stored token.
    const { data: storedToken, error: reReadError } = await supabase
      .from('email_unsubscribe_tokens')
      .select('token')
      .eq('email', normalizedEmail)
      .maybeSingle()

    if (reReadError || !storedToken) {
      console.error('Failed to read back unsubscribe token after upsert', {
        error: reReadError,
        email: normalizedEmail,
      })
      await supabase.from('email_send_log').insert({
        message_id: messageId,
        template_name: templateName,
        recipient_email: effectiveRecipient,
        status: 'failed',
        error_message: 'Failed to confirm unsubscribe token storage',
      })
      return new Response(
        JSON.stringify({ error: 'Failed to prepare email' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }
    unsubscribeToken = storedToken.token
  } else {
    // Token exists but is already used — email should have been caught by suppression check above.
    // This is a safety fallback; log and skip sending.
    console.warn('Unsubscribe token already used but email not suppressed', {
      email: normalizedEmail,
    })
    await supabase.from('email_send_log').insert({
      message_id: messageId,
      template_name: templateName,
      recipient_email: effectiveRecipient,
      status: 'suppressed',
      error_message:
        'Unsubscribe token used but email missing from suppressed list',
    })
    return new Response(
      JSON.stringify({ success: false, reason: 'email_suppressed' }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }

  // 4. Render React Email template to HTML and plain text
  const html = await renderAsync(
    React.createElement(template.component, templateData)
  )
  const plainText = await renderAsync(
    React.createElement(template.component, templateData),
    { plainText: true }
  )

  // Resolve subject — supports static string or dynamic function
  const resolvedSubject =
    typeof template.subject === 'function'
      ? template.subject(templateData)
      : template.subject

  // Explicit user-requested delivery only. Historical queues remain untouched.
  if (immediate) {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) return respond(503, { error: 'Email provider is not configured' })
    try {
      const delivery = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from: emailFrom, to: [effectiveRecipient.trim().toLowerCase()], subject: resolvedSubject, html, text: plainText }),
      })
      const result = await delivery.json().catch(() => null)
      if (!delivery.ok || typeof result?.id !== 'string') return respond(502, { success: false, sent: false, queued: false, error: 'O provedor não confirmou o envio do e-mail.' })
      const { error: logError } = await supabase.from('email_send_log').insert({
        message_id: messageId, template_name: templateName, recipient_email: effectiveRecipient,
        status: 'sent', metadata: externalMetadata || {},
      })
      return respond(200, { success: true, sent: true, queued: false, messageId, log_pending: Boolean(logError) })
    } catch {
      return respond(502, { success: false, sent: false, queued: false, error: 'Não foi possível confirmar o envio. Tente novamente.' })
    }
  }

  // 5. Enqueue the pre-rendered email for async processing by the dispatcher.
  // The dispatcher (process-email-queue) handles sending, retries, and rate-limit backoff.

  // Commit the receipt, queue entry and pending log in one database transaction.
  const { data: receipt, error: enqueueError } = await supabase.rpc('enqueue_transactional_email_once', {
    request_key: idempotencyKey,
    log_metadata: externalMetadata || {},
    payload: {
      message_id: messageId,
      to: effectiveRecipient,
      from: emailFrom,
      sender_domain: 'psicoone-mail.sevendevx.com',
      subject: resolvedSubject,
      html,
      text: plainText,
      purpose: 'transactional',
      label: templateName,
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  })

  if (enqueueError) {
    return new Response(JSON.stringify({ error: 'Failed to enqueue email' }), {
      status: enqueueError.code === '22023' ? 409 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!receipt || typeof receipt.message_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.message_id)) {
    return respond(502, { error: 'Invalid queue acknowledgement' })
  }
  if (receipt.state !== 'queued') {
    if (receipt.state === 'sent') return respond(200, {
      success: true, queued: false, sent: true, already_sent: true, messageId: receipt.message_id,
    })
    return respond(409, { success: false, queued: false, sent: false, error: 'Existing message requires review' })
  }
  messageId = receipt.message_id

  // Manual staging: do not wake the worker or activate scheduled jobs.

  console.log('Transactional email enqueued')

  return new Response(
    JSON.stringify({ success: true, queued: true, sent: false, manual_processing: true, messageId }),
    {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    }
  )
})
