import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { supabase } from '@/lib/supabase';
import { VapiWebhookPayloadSchema } from '@/types';
import type { VapiMessage } from '@/types';
import { logInfo, logWarn, logError } from '@/lib/logger';

export const maxDuration = 60;

/**
 * POST /api/vapi/webhook
 *
 * Receives lifecycle events from Vapi:
 * - end-of-call-report: Upserts transcript, recording, summary, duration
 * - status-update: Ensures call record exists when call begins
 *
 * ALWAYS returns 200 to prevent Vapi retry storms.
 */
export async function POST(req: NextRequest) {
  try {
    const incoming = req.headers.get("x-webhook-secret");
    const expected = process.env.VAPI_WEBHOOK_SECRET;
    if (expected && incoming !== expected) {
      logWarn("Vapi webhook: invalid secret");
      return NextResponse.json({ ok: true });
    }

    const rawBody: unknown = await req.json();
    const parsed = VapiWebhookPayloadSchema.safeParse(rawBody);

    if (!parsed.success) {
      logWarn('Vapi webhook: invalid payload shape', { validationError: parsed.error.message });
      return NextResponse.json({ ok: true });
    }

    const message = parsed.data.message;
    if (!message) {
      return NextResponse.json({ ok: true });
    }

    const callId = message.call?.id;
    if (!callId) {
      return NextResponse.json({ ok: true });
    }

    waitUntil(
      processWebhookMessage(message).catch((err) => {
        logError('Vapi webhook: background processing failed', err, { callId });
      })
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('Vapi webhook: unhandled error', err);
    // ALWAYS return 200 to prevent Vapi retry storms
    return NextResponse.json({ ok: true });
  }
}

async function processWebhookMessage(message: VapiMessage): Promise<void> {
  const callId = message.call?.id;
  if (!callId) {
    return;
  }

  // ---- Handle end-of-call report ----
  if (message.type === 'end-of-call-report') {
    const transcript = message.messages || message.transcript || null;
    const recordingUrl = message.recordingUrl || null;
    const summary = message.summary || null;
    const durationSeconds = message.durationSeconds || null;
    const outcome = mapEndedReason(message.endedReason);

    logInfo('Vapi end-of-call-report received', {
      callId,
      outcome: outcome ?? 'unknown',
      durationSeconds: durationSeconds ?? undefined,
    });

    // Upsert call record — handles out-of-order webhooks safely
    const { error: upsertError } = await supabase
      .from('calls')
      .upsert(
        {
          retell_call_id: callId,
          transcript: typeof transcript === 'string' ? { raw: transcript } : transcript,
          recording_url: recordingUrl,
          summary,
          duration_seconds: durationSeconds,
          ended_at: new Date().toISOString(),
          outcome,
        },
        { onConflict: 'retell_call_id' }
      );

    if (upsertError) {
      logError('Vapi webhook: call upsert failed', upsertError, { callId });
    }

    // Update prospect status for definitive outcomes
    if (outcome === 'rejected' || outcome === 'no_answer' || outcome === 'voicemail') {
      try {
        const { data: callData, error: callLookupError } = await supabase
          .from('calls')
          .select('prospect_id')
          .eq('retell_call_id', callId)
          .maybeSingle();

        if (callLookupError) {
          logError('Vapi webhook: prospect lookup failed', callLookupError, { callId });
          return;
        }

        if (callData?.prospect_id) {
          const newStatus = outcome === 'rejected' ? 'rejected' : 'no_answer';
          const { error: updateError } = await supabase
            .from('prospects')
            .update({ status: newStatus, updated_at: new Date().toISOString() })
            .eq('id', callData.prospect_id);

          if (updateError) {
            logError('Vapi webhook: prospect status update failed', updateError, {
              callId,
              prospectId: callData.prospect_id,
            });
          }
        }
      } catch (lookupErr) {
        logError('Vapi webhook: prospect lookup failed', lookupErr, { callId });
      }
    }
  }

  // ---- Handle status updates (call started, ringing, etc.) ----
  if (message.type === 'status-update') {
    const customerNumber = message.call?.customer?.number;
    const metadata = message.call?.metadata || {};
    const prospectId = metadata.prospect_id;

    if (prospectId) {
      logInfo('Vapi status-update: ensuring call record', { callId, prospectId });

      const { error: statusUpsertError } = await supabase
        .from('calls')
        .upsert(
          {
            retell_call_id: callId,
            prospect_id: prospectId,
            phone: customerNumber || null,
            started_at: new Date().toISOString(),
          },
          { onConflict: 'retell_call_id' }
        );

      if (statusUpsertError) {
        logError('Vapi webhook: status upsert failed', statusUpsertError, { callId, prospectId });
      }
    }
  }
}

/**
 * Maps Vapi's endedReason string to our call outcome enum.
 */
function mapEndedReason(reason?: string): string | null {
  if (!reason) return null;
  const map: Record<string, string> = {
    'assistant-error': 'error',
    'assistant-not-found': 'error',
    'db-error': 'error',
    'no-server-available': 'error',
    'pipeline-error-openai-llm-failed': 'error',
    'silence-timed-out': 'no_answer',
    'voicemail': 'voicemail',
    'customer-busy': 'busy',
    'customer-ended-call': 'connected',
    'customer-did-not-answer': 'no_answer',
    'assistant-ended-call': 'connected',
    'phone-call-provider-closured-websocket': 'error',
    'exceeded-max-duration': 'connected',
    'manually-canceled': 'error',
  };
  return map[reason] || 'connected';
}
