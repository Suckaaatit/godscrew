import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

export function formatDuration(seconds?: number | null) {
  if (!seconds || seconds <= 0) return "-";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatCurrencyFromCents(amountCents?: number | null) {
  const amount = Number(amountCents || 0) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export function getStatusTone(status: string) {
  const normalized = status.toLowerCase();
  if (
    normalized === "paid" ||
    normalized === "closed" ||
    normalized === "completed" ||
    normalized === "connected"
  ) {
    return "success";
  }
  if (
    normalized === "pending" ||
    normalized === "interested" ||
    normalized === "followup" ||
    normalized === "processing" ||
    normalized === "called"
  ) {
    return "warning";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "rejected" || normalized === "do_not_call") {
    return "danger";
  }
  if (normalized === "no_answer" || normalized === "voicemail" || normalized === "expired" || normalized === "cancelled") {
    return "neutral";
  }
  return "neutral";
}
