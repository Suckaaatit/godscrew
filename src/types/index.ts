import { z } from 'zod';

// ============================================================
// Environment Variable Schema
// ============================================================
export const EnvSchema = z.object({
  VAPI_API_KEY: z.string().min(1, 'VAPI_API_KEY is required'),
  VAPI_ASSISTANT_ID: z.string().min(1, 'VAPI_ASSISTANT_ID is required'),
  VAPI_PHONE_NUMBER_ID: z.string().min(1, 'VAPI_PHONE_NUMBER_ID is required'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_', 'STRIPE_SECRET_KEY must start with sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'STRIPE_WEBHOOK_SECRET is required'),
  STRIPE_LINK_650: z.string().url('STRIPE_LINK_650 must be a valid URL'),
  STRIPE_LINK_1100: z.string().url('STRIPE_LINK_1100 must be a valid URL'),
  RESEND_API_KEY: z.string().min(1, 'RESEND_API_KEY is required'),
  RESEND_FROM_EMAIL: z.string().email('RESEND_FROM_EMAIL must be a valid email'),
  RESEND_FROM_NAME: z.string().optional().or(z.literal('')),
  RESEND_REPLY_TO_EMAIL: z.string().email('RESEND_REPLY_TO_EMAIL must be a valid email').optional().or(z.literal('')),
  BUSINESS_PHONE_NUMBER: z.string().optional().or(z.literal('')),
  BUSINESS_WEBSITE_URL: z.string().url('BUSINESS_WEBSITE_URL must be a valid URL').optional().or(z.literal('')),
  NEXT_PUBLIC_APP_URL: z.string().url('NEXT_PUBLIC_APP_URL must be a valid URL'),
  INTERNAL_API_SECRET: z.string().min(16, 'INTERNAL_API_SECRET must be at least 16 characters'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

// ============================================================
// Vapi Webhook Payload Schema
// ============================================================
export const VapiToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string().default('{}'),
  }),
});

export type VapiToolCall = z.infer<typeof VapiToolCallSchema>;

export const VapiCallSchema = z.object({
  id: z.string(),
  phoneNumber: z.object({
    id: z.string(),
    number: z.string(),
  }).optional(),
  customer: z.object({
    number: z.string(),
  }).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
}).optional();

export const VapiMessageSchema = z.object({
  type: z.string(),
  call: VapiCallSchema,
  // end-of-call-report fields
  endedReason: z.string().optional(),
  transcript: z.union([z.string(), z.array(z.unknown())]).optional(),
  recordingUrl: z.string().optional(),
  summary: z.string().optional(),
  messages: z.array(z.object({
    role: z.string(),
    message: z.string(),
    time: z.number().optional(),
  })).optional(),
  durationSeconds: z.number().optional(),
  // tool-calls fields
  toolCallList: z.array(VapiToolCallSchema).optional(),
  // legacy function-call fields
  functionCall: z.object({
    name: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }).optional(),
});

export type VapiMessage = z.infer<typeof VapiMessageSchema>;

export const VapiWebhookPayloadSchema = z.object({
  message: VapiMessageSchema.optional(),
});

export type VapiWebhookPayload = z.infer<typeof VapiWebhookPayloadSchema>;

// ============================================================
// Internal Process Payment Payload
// ============================================================
export const ProcessPaymentPayloadSchema = z.object({
  call_id: z.string().uuid('call_id must be a UUID'),
  prospect_id: z.string().uuid('prospect_id must be a UUID'),
  email: z.string().email('email must be valid'),
  retell_call_id: z.string().min(1, 'retell_call_id is required'),
  secret: z.string().min(1, 'secret is required'),
  plan_tier: z.enum(['one_incident', 'two_incident']).optional(),
  plan_label: z.string().optional(),
  price_id: z.string().startsWith('price_').optional(),
  company_name: z.string().optional(),
  prospect_name: z.string().optional(),
});

export type ProcessPaymentPayload = z.infer<typeof ProcessPaymentPayloadSchema>;

// ============================================================
// Database Row Types
// ============================================================
export interface ProspectRow {
  id: string;
  phone: string;
  email: string | null;
  company_name: string | null;
  contact_name: string | null;
  status: string;
  source: string | null;
  total_calls: number;
  last_called_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CallRow {
  id: string;
  prospect_id: string;
  retell_call_id: string;
  phone: string | null;
  outcome: string | null;
  transcript: Record<string, unknown> | null;
  recording_url: string | null;
  summary: string | null;
  duration_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  prospect_id: string;
  call_id: string;
  stripe_session_id: string | null;
  amount_cents: number | null;
  currency: string;
  status: string;
  email_sent: boolean;
  email_sent_at: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface FollowupRow {
  id: string;
  prospect_id: string;
  call_id: string | null;
  scheduled_at: string;
  reason: string | null;
  status: string;
  created_at: string;
}

export interface PhoneNumberRow {
  id: string;
  number: string;
  daily_call_count: number;
  total_calls: number;
  answered_calls: number;
  answer_rate: number;
  last_used_at: string | null;
  active: boolean;
  created_at: string;
}

export interface ObjectionRow {
  id: string;
  call_id: string;
  objection_type: string;
  prospect_statement: string | null;
  ai_response: string | null;
  resolved: boolean;
  created_at: string;
}

export interface ProcessedToolCallRow {
  id: string;
  tool_call_id: string;
  function_name: string | null;
  response_text: string | null;
  created_at: string;
}

export interface StripeEventRow {
  id: string;
  event_id: string;
  event_type: string | null;
  processed_at: string;
}

// ============================================================
// Resend Webhook Payload
// ============================================================
export const ResendWebhookSchema = z.object({
  type: z.string(),
  data: z.object({
    to: z.array(z.string()).optional(),
    email: z.string().optional(),
    delivered_at: z.string().optional(),
    created_at: z.string().optional(),
    open_count: z.number().optional(),
    click_count: z.number().optional(),
  }).passthrough().optional(),
});

export type ResendWebhookPayload = z.infer<typeof ResendWebhookSchema>;

// ============================================================
// Structured Log Type
// ============================================================
export interface StructuredLog {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
  callId?: string;
  prospectId?: string;
  stripeEventId?: string;
  toolCallId?: string;
  functionName?: string;
  [key: string]: unknown;
}
