import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { config } from '@/lib/config';
import { VapiWebhookPayloadSchema } from '@/types';
import type { ProcessPaymentPayload, VapiToolCall } from '@/types';
import { logInfo, logWarn, logError } from '@/lib/logger';

export const maxDuration = 60;

/**
 * POST /api/vapi/actions
 *
 * Handles mid-call tool/function calls from Vapi's LLM.
 * CRITICAL: Every response must return to Vapi in <500ms.
 * Heavy work (Stripe, Resend, DB writes) fires via self-call to /api/internal/process-payment.
 *
 * Supported functions:
 * - send_payment_email: Collects email, fires background payment processing
 * - log_objection: Records objection to DB
 * - schedule_followup: Creates followup callback
 * - confirm_payment: Checks if Stripe payment completed
 * - mark_do_not_call: Removes prospect from calling list
 *
 * Deduplication: Every tool_call_id is stored in processed_tool_calls table.
 * Retries return the cached response instead of re-executing.
 */
export async function POST(req: NextRequest) {
  try {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      logWarn('Vapi actions: invalid JSON body');
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const parsed = VapiWebhookPayloadSchema.safeParse(rawBody);

    if (!parsed.success) {
      logWarn('Vapi actions: invalid payload', { validationError: parsed.error.message });
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const message = parsed.data.message;
    if (!message) {
      return NextResponse.json({ error: 'No message' }, { status: 400 });
    }

    const callId = message.call?.id;
    const metadata = message.call?.metadata || {};

    // ---- Vapi tool-calls format (array of tool calls) ----
    if (message.type === 'tool-calls' && message.toolCallList) {
      const results: Array<{ toolCallId: string; result: string }> = [];

      for (const toolCall of message.toolCallList as VapiToolCall[]) {
        const toolCallId = toolCall.id;
        const functionName = toolCall.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          logWarn('Vapi actions: failed to parse tool call arguments', { toolCallId, functionName });
        }

        // DEDUP: Check if this exact tool call was already processed
        const { data: existing, error: existingLookupError } = await supabase
          .from('processed_tool_calls')
          .select('response_text')
          .eq('tool_call_id', toolCallId)
          .maybeSingle();

        if (existingLookupError) {
          logError('Vapi actions: dedup lookup failed', existingLookupError, {
            toolCallId,
            functionName,
          });
        }

        if (existing) {
          logInfo('Vapi actions: returning cached response for duplicate tool call', {
            toolCallId,
            functionName,
          });
          results.push({ toolCallId, result: existing.response_text || 'Processed.' });
          continue;
        }

        // Process the function
        const response = await handleFunction(functionName, args, callId, metadata);

        // Store result for dedup (upsert to handle race conditions)
        try {
          await supabase
            .from('processed_tool_calls')
            .upsert(
              {
                tool_call_id: toolCallId,
                function_name: functionName,
                response_text: response,
              },
              { onConflict: 'tool_call_id' }
            );
        } catch (dedupErr) {
          logError('Vapi actions: dedup insert failed', dedupErr, { toolCallId, functionName });
        }

        logInfo('Vapi actions: tool call processed', { toolCallId, functionName, callId });
        results.push({ toolCallId, result: response });
      }

      return NextResponse.json({
        results: results.map((r) => ({
          toolCallId: r.toolCallId,
          result: r.result,
        })),
      });
    }

    // ---- Legacy function-call format (older Vapi versions) ----
    if (message.type === 'function-call' && message.functionCall) {
      const { name, parameters } = message.functionCall;
      const response = await handleFunction(
        name,
        parameters as Record<string, unknown>,
        callId,
        metadata
      );
      return NextResponse.json({ result: response });
    }

    return NextResponse.json({ result: 'No action taken' });
  } catch (err) {
    logError('Vapi actions: unhandled error', err);
    return NextResponse.json({ result: 'An error occurred, please try again.' });
  }
}

// ============================================================
// Function Router
// ============================================================
async function handleFunction(
  name: string,
  args: Record<string, unknown>,
  callId: string | undefined,
  metadata: Record<string, string> | undefined
): Promise<string> {
  switch (name) {
    case 'send_payment_email':
      return handleSendPaymentEmail(args, callId, metadata);
    case 'log_objection':
      return handleLogObjection(args, callId);
    case 'schedule_followup':
      return handleScheduleFollowup(args, callId, metadata);
    case 'confirm_payment':
      return handleConfirmPayment(callId);
    case 'mark_do_not_call':
      return handleDoNotCall(args, callId, metadata);
    default:
      logWarn('Vapi actions: unknown function called', { functionName: name, callId });
      return `Unknown function: ${name}`;
  }
}

// ============================================================
// send_payment_email
// Returns immediate response to Vapi. Fires self-call for heavy work.
// ============================================================
async function handleSendPaymentEmail(
  args: Record<string, unknown>,
  callId: string | undefined,
  metadata: Record<string, string> | undefined
): Promise<string> {
  const rawEmail = String(args.email || args.recipient_email || '');
  const email = cleanEmail(rawEmail);

  if (!email || !email.includes('@') || !email.includes('.')) {
    return "I didn't catch a valid email. Could you spell that out for me one more time?";
  }

  if (!callId) {
    logError('send_payment_email: no callId available', new Error('Missing callId'));
    return "I'm having a technical issue. Let me try again in a moment.";
  }

  // Look up existing call record to get prospect_id
  let dbCallId: string;
  let prospectId: string;

  try {
    const { data: callData, error: callLookupError } = await supabase
      .from('calls')
      .select('id, prospect_id')
      .eq('retell_call_id', callId)
      .maybeSingle();

    if (callLookupError && callLookupError.code !== 'PGRST116') {
      logError('send_payment_email: call lookup failed', callLookupError, { callId });
      return "I'm having a technical issue. Let me try again.";
    }

    if (callData?.id && callData?.prospect_id) {
      dbCallId = callData.id;
      prospectId = callData.prospect_id;
    } else {
      // Call record doesn't exist yet (out-of-order) — create it from metadata
      const metaProspectId = metadata?.prospect_id;
      if (!metaProspectId) {
        logError('send_payment_email: no prospect_id in metadata', new Error('Missing prospect_id'), { callId });
        return "I'm having a technical issue. Let me try again.";
      }

      const { data: newCall, error: insertError } = await supabase
        .from('calls')
        .upsert(
          {
            retell_call_id: callId,
            prospect_id: metaProspectId,
            phone: metadata?.phone || null,
            started_at: new Date().toISOString(),
          },
          { onConflict: 'retell_call_id' }
        )
        .select('id, prospect_id')
        .maybeSingle();

      if (insertError || !newCall) {
        logError('send_payment_email: failed to create call record', insertError || new Error('No data returned'), { callId });
        return "I'm having a technical issue. Let me try again.";
      }

      dbCallId = newCall.id;
      prospectId = newCall.prospect_id;
    }
  } catch (lookupErr) {
    logError('send_payment_email: call lookup failed', lookupErr, { callId });
    return "I'm having a technical issue. Let me try again.";
  }

  const planSelection = parsePlanSelection(args);
  const prospectName = safeTextArg(args, ['prospect_name', 'name', 'contact_name']);
  const companyName = safeTextArg(args, ['company_name', 'property_name', 'property']);

  // Update prospect email
  try {
    await supabase
      .from('prospects')
      .update({ email, updated_at: new Date().toISOString() })
      .eq('id', prospectId);
  } catch (emailUpdateErr) {
    logError('send_payment_email: prospect email update failed', emailUpdateErr, { prospectId });
  }

  // Ensure a placeholder payment row exists so dead-letter cron can retry
  // even if the self-call to /api/internal/process-payment fails.
  try {
    const { data: existingPayment, error: paymentLookupError } = await supabase
      .from('payments')
      .select('id')
      .eq('call_id', dbCallId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (paymentLookupError) {
      logError('send_payment_email: payment lookup failed', paymentLookupError, {
        callId: dbCallId,
        prospectId,
      });
    } else if (!existingPayment) {
      const { error: insertPaymentError } = await supabase.from('payments').insert({
        call_id: dbCallId,
        prospect_id: prospectId,
        status: 'pending',
        email_sent: false,
      });

      if (insertPaymentError) {
        logError('send_payment_email: failed to insert placeholder payment row', insertPaymentError, {
          callId: dbCallId,
          prospectId,
        });
      }
    }
  } catch (paymentPrepErr) {
    logError('send_payment_email: payment preparation failed', paymentPrepErr, {
      callId: dbCallId,
      prospectId,
    });
  }

  // Fire background self-call for Stripe + Resend (non-blocking)
  fireBackgroundPayment({
    call_id: dbCallId,
    prospect_id: prospectId,
    email,
    retell_call_id: callId,
    secret: config.app.internalSecret,
    plan_tier: planSelection.planTier,
    plan_label: planSelection.planLabel,
    price_id: planSelection.priceId,
    prospect_name: prospectName || undefined,
    company_name: companyName || undefined,
  });

  logInfo('send_payment_email: background payment fired', { callId, prospectId, email: email.replace(/(.{2}).*(@.*)/, '$1***$2') });

  return "I'm sending that payment link to your email right now. While that's on its way, let me ask you — what's been your biggest challenge with your current setup?";
}

/**
 * Fire-and-forget POST to /api/internal/process-payment.
 * Runs in its own serverless invocation — survives container freeze.
 * Dead-letter cron catches failures.
 */
function fireBackgroundPayment(payload: ProcessPaymentPayload): void {
  const url = `${config.app.url}/api/internal/process-payment`;
  const dashboardUser = process.env.DASHBOARD_BASIC_USER?.trim();
  const dashboardPass = process.env.DASHBOARD_BASIC_PASS?.trim() ?? "";
  const basicAuth =
    dashboardUser && dashboardUser.length > 0
      ? `Basic ${Buffer.from(`${dashboardUser}:${dashboardPass}`).toString("base64")}`
      : null;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (basicAuth) headers.Authorization = basicAuth;

  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }).catch((err) => {
    logError('fireBackgroundPayment: self-call failed (dead-letter cron will retry)', err, {
      callId: payload.call_id,
      prospectId: payload.prospect_id,
    });
  });
}

// ============================================================
// log_objection
// ============================================================
async function handleLogObjection(
  args: Record<string, unknown>,
  callId: string | undefined
): Promise<string> {
  if (!callId) return 'Noted.';

  try {
    const { data: callData } = await supabase
      .from('calls')
      .select('id')
      .eq('retell_call_id', callId)
      .maybeSingle();

    if (callData) {
      const objectionType = String(args.type || args.objection_type || 'other');
      const validTypes = ['not_interested', 'too_expensive', 'send_info', 'call_later', 'has_provider', 'busy_moment', 'other'];
      const safeType = validTypes.includes(objectionType) ? objectionType : 'other';

      await supabase.from('objections').insert({
        call_id: callData.id,
        objection_type: safeType,
        prospect_statement: String(args.verbatim || args.prospect_statement || ''),
        ai_response: String(args.ai_response || ''),
        resolved: false,
      });

      logInfo('log_objection: recorded', { callId, objectionType: safeType });
    }
  } catch (objErr) {
    logError('log_objection: failed to insert', objErr, { callId });
  }

  return 'Objection noted. Continue the conversation.';
}

// ============================================================
// schedule_followup
// ============================================================
async function handleScheduleFollowup(
  args: Record<string, unknown>,
  callId: string | undefined,
  metadata: Record<string, string> | undefined
): Promise<string> {
  const prospectId = metadata?.prospect_id;
  if (!prospectId) return "I'll make a note to call you back.";

  let dbCallId: string | null = null;
  try {
    const { data: callData } = await supabase
      .from('calls')
      .select('id')
      .eq('retell_call_id', callId || '')
      .maybeSingle();
    dbCallId = callData?.id || null;
  } catch {
    // Call record may not exist yet — that's fine
  }

  // Parse suggested time or default to tomorrow
  let scheduledAt = new Date();
  scheduledAt.setDate(scheduledAt.getDate() + 1); // Default: tomorrow same time

  const timeStr = String(args.suggested_time || args.time || '');
  if (timeStr) {
    const lower = timeStr.toLowerCase();
    if (lower.includes('hour')) {
      const hours = parseInt(timeStr) || 2;
      scheduledAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    } else if (lower.includes('tomorrow')) {
      // Already set to tomorrow
    } else if (lower.includes('minute')) {
      const minutes = parseInt(timeStr) || 30;
      scheduledAt = new Date(Date.now() + minutes * 60 * 1000);
    } else {
      try {
        const parsed = new Date(timeStr);
        if (!isNaN(parsed.getTime())) {
          scheduledAt = parsed;
        }
      } catch {
        // Keep default
      }
    }
  }

  try {
    await supabase.from('followups').insert({
      prospect_id: prospectId,
      call_id: dbCallId,
      scheduled_at: scheduledAt.toISOString(),
      reason: String(args.reason || 'Prospect asked for callback'),
      status: 'pending',
    });

    await supabase
      .from('prospects')
      .update({ status: 'followup', updated_at: new Date().toISOString() })
      .eq('id', prospectId);

    logInfo('schedule_followup: created', { callId: callId || 'unknown', prospectId, scheduledAt: scheduledAt.toISOString() });
  } catch (followupErr) {
    logError('schedule_followup: failed', followupErr, { prospectId });
  }

  return "Follow-up scheduled. I'll call you back at the suggested time. Have a great day!";
}

// ============================================================
// confirm_payment
// ============================================================
async function handleConfirmPayment(callId: string | undefined): Promise<string> {
  if (!callId) {
    return "I don't see it yet. It may still be processing, please give it a moment.";
  }

  try {
    const { data: callData } = await supabase
      .from('calls')
      .select('id')
      .eq('retell_call_id', callId)
      .maybeSingle();

    if (!callData) {
      return "I'm still processing. Give it just a moment and let me know when you've completed it.";
    }

    const { data: payment } = await supabase
      .from('payments')
      .select('status')
      .eq('call_id', callData.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (payment?.status === 'paid') {
      logInfo('confirm_payment: payment confirmed', { callId });
      return "Payment confirmed! Welcome aboard — you're all set. You'll receive a confirmation email shortly. Is there anything else I can help you with?";
    }

    return "I don't see the payment just yet — sometimes it takes a few seconds to process. Try refreshing the page and completing the payment, then let me know when it goes through.";
  } catch (confirmErr) {
    logError('confirm_payment: lookup failed', confirmErr, { callId });
    return "I don't see it yet. It may still be processing, please give it a moment.";
  }
}

// ============================================================
// mark_do_not_call
// ============================================================
async function handleDoNotCall(
  args: Record<string, unknown>,
  callId: string | undefined,
  metadata: Record<string, string> | undefined
): Promise<string> {
  let prospectId =
    (typeof args.prospect_id === 'string' ? args.prospect_id : null) ||
    metadata?.prospect_id ||
    null;

  const phone = typeof args.phone === 'string' ? args.phone.trim() : null;

  // Fallback 1: find by phone number
  if (!prospectId && phone) {
    const { data } = await supabase.from('prospects').select('id').eq('phone', phone).maybeSingle();
    prospectId = data?.id || null;
  }

  // Fallback 2: find by call_id
  if (!prospectId && callId) {
    const { data } = await supabase
      .from('calls')
      .select('prospect_id')
      .eq('retell_call_id', callId)
      .maybeSingle();
    prospectId = data?.prospect_id || null;
  }

  if (!prospectId) {
    // STILL acknowledge to the prospect — log for manual review
    logError('DNC requested but could not identify prospect', new Error('No prospect found for DNC request'), { callId, phone, args });
    return "Understood. I've flagged your do-not-call request for immediate manual confirmation.";
  }

  await supabase
    .from('prospects')
    .update({ status: 'do_not_call', updated_at: new Date().toISOString() })
    .eq('id', prospectId);

  return "Understood. I've removed you from our list. You won't receive any more calls from us.";
}

// ============================================================
// Email Cleanup
// STT engines pass emails as "john at gmail dot com" or with spaces
// ============================================================
function cleanEmail(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s+/g, '')
    .replace(/\bat\b/gi, '@')
    .replace(/\bdot\b/gi, '.')
    .replace(/[,;]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/@+/g, '@');
}

function safeTextArg(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function parsePlanSelection(args: Record<string, unknown>): {
  planTier: 'one_incident' | 'two_incident';
  planLabel: string;
  priceId?: string;
} {
  const explicitPriceId = typeof args.price_id === 'string' ? args.price_id.trim() : '';
  if (explicitPriceId.startsWith('price_')) {
    const explicitPlan = safeTextArg(args, ['plan_tier', 'plan', 'plan_name', 'coverage']);
    const explicitTier =
      explicitPlan.includes('2') || explicitPlan.toLowerCase().includes('two')
        ? 'two_incident'
        : 'one_incident';
    return {
      planTier: explicitTier,
      planLabel: explicitTier === 'two_incident' ? 'Annual Biohazard Response - 2 Incident Coverage' : 'Annual Biohazard Response - 1 Incident Coverage',
      priceId: explicitPriceId,
    };
  }

  const rawPlan = safeTextArg(args, ['plan_tier', 'plan', 'plan_name', 'coverage']).toLowerCase();
  const incidentsRaw = String(args.incidents || args.incident_count || '').trim();
  const amountRaw = String(args.amount || args.amount_cents || '').trim();
  const likelyTwoIncident =
    rawPlan.includes('2') ||
    rawPlan.includes('two') ||
    incidentsRaw === '2' ||
    amountRaw === '1100' ||
    amountRaw === '110000';

  const planTier: 'one_incident' | 'two_incident' = likelyTwoIncident ? 'two_incident' : 'one_incident';
  return {
    planTier,
    planLabel:
      planTier === 'two_incident'
        ? 'Annual Biohazard Response - 2 Incident Coverage'
        : 'Annual Biohazard Response - 1 Incident Coverage',
  };
}
