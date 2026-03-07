import { EnvSchema } from '@/types';

/**
 * Validates all required environment variables at module load time.
 * Fails fast with a clear, actionable error message if any are missing.
 *
 * Usage: import { config } from '@/lib/config' — if this import succeeds,
 * all env vars are guaranteed present and correctly typed.
 */
function loadConfig() {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    );
    throw new Error(
      `\n❌ Missing or invalid environment variables:\n${missing.join('\n')}\n\nCopy .env.example to .env.local and fill in all values.\n`
    );
  }

  const clean = (value: string) => value.trim().replace(/\\r/g, "").replace(/\\n/g, "");
  const cleanOrFallback = (value: string | undefined, fallback: string) => {
    const next = typeof value === "string" ? value.trim() : "";
    return next || fallback;
  };

  return {
    vapi: {
      apiKey: clean(result.data.VAPI_API_KEY),
      assistantId: clean(result.data.VAPI_ASSISTANT_ID),
      phoneNumberId: clean(result.data.VAPI_PHONE_NUMBER_ID),
    },
    supabase: {
      url: result.data.NEXT_PUBLIC_SUPABASE_URL.trim(),
      serviceRoleKey: clean(result.data.SUPABASE_SERVICE_ROLE_KEY),
    },
    stripe: {
      secretKey: clean(result.data.STRIPE_SECRET_KEY),
      webhookSecret: clean(result.data.STRIPE_WEBHOOK_SECRET),
      link650: result.data.STRIPE_LINK_650.trim(),
      link1100: result.data.STRIPE_LINK_1100.trim(),
    },
    resend: {
      apiKey: clean(result.data.RESEND_API_KEY),
      fromEmail: result.data.RESEND_FROM_EMAIL.trim(),
      fromName: cleanOrFallback(result.data.RESEND_FROM_NAME, "Adam at God's Cleaning Crew"),
      replyToEmail:
        cleanOrFallback(
          result.data.RESEND_REPLY_TO_EMAIL,
          `support@${String(result.data.RESEND_FROM_EMAIL || "").split("@")[1] || "godscleaningcrew.com"}`
        ),
      businessPhone: cleanOrFallback(result.data.BUSINESS_PHONE_NUMBER, "(833) 000-0000"),
      businessWebsite: cleanOrFallback(result.data.BUSINESS_WEBSITE_URL, result.data.NEXT_PUBLIC_APP_URL),
    },
    app: {
      url: result.data.NEXT_PUBLIC_APP_URL.trim(),
      internalSecret: clean(result.data.INTERNAL_API_SECRET),
    },
  } as const;
}

export const config = loadConfig();
