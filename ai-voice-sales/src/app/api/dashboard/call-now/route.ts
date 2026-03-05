import { NextRequest } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { supabase } from "@/lib/supabase";
import { parseJson, withErrorHandling, ok, fail, requireSupabaseConfigured } from "@/app/api/dashboard/_utils";

const CallNowSchema = z.object({
  prospect_id: z.string().uuid(),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  contact_name: z.string().max(255).nullable().optional(),
});

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return withErrorHandling("dashboard call-now failed", async () => {
    const supabaseGuard = requireSupabaseConfigured();
    if (supabaseGuard) return supabaseGuard;

    const parsed = await parseJson(req, CallNowSchema);
    if (parsed.error || !parsed.data) return fail(parsed.error || "Invalid payload", 400);

    const payload = parsed.data;
    const nowIso = new Date().toISOString();
    const { data: lockedProspect, error: lockError } = await supabase
      .from("prospects")
      .update({ status: "dialing", updated_at: nowIso })
      .eq("id", payload.prospect_id)
      .in("status", ["pending", "followup", "called", "failed", "contacted", "no_answer"])
      .select("id, phone, contact_name, total_calls")
      .maybeSingle();

    if (lockError || !lockedProspect) {
      return fail("Prospect is already dialing or not callable.", 409);
    }

    const phoneNumber = payload.phone || lockedProspect.phone;
    if (!phoneNumber || !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
      await supabase
        .from("prospects")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", payload.prospect_id);
      return fail("Prospect phone must be valid E.164.", 400);
    }

    const contactName = payload.contact_name || lockedProspect.contact_name || null;
    const response = await fetch("https://api.vapi.ai/call/phone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.vapi.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: config.vapi.assistantId,
        phoneNumberId: config.vapi.phoneNumberId,
        customer: {
          number: phoneNumber,
          name: contactName || undefined,
        },
        metadata: {
          prospect_id: payload.prospect_id,
          phone: phoneNumber,
        },
      }),
    });

    if (!response.ok) {
      await supabase
        .from("prospects")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", payload.prospect_id);
      return fail(`Vapi call failed (${response.status})`, 502);
    }

    const callPayload = (await response.json()) as { id?: string };
    if (!callPayload.id) {
      await supabase
        .from("prospects")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", payload.prospect_id);
      return fail("Vapi response missing call ID.", 502);
    }

    const [prospectUpdateRes, callUpsertRes] = await Promise.all([
      supabase
        .from("prospects")
        .update({
          status: "called",
          total_calls: Number(lockedProspect.total_calls || 0) + 1,
          last_called_at: nowIso,
          updated_at: nowIso,
        })
        .eq("id", payload.prospect_id),
      supabase.from("calls").upsert(
        {
          retell_call_id: callPayload.id,
          prospect_id: payload.prospect_id,
          phone: phoneNumber,
          started_at: nowIso,
        },
        { onConflict: "retell_call_id" }
      ),
    ]);

    if (prospectUpdateRes.error || callUpsertRes.error) {
      await supabase
        .from("prospects")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", payload.prospect_id);
      return fail(
        prospectUpdateRes.error?.message || callUpsertRes.error?.message || "Failed to persist call initiation.",
        500
      );
    }

    return ok({ callId: callPayload.id, call: callPayload }, 1);
  });
}
