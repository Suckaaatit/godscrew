import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET missing" }, { status: 500 });
  }

  const requestOrigin = new URL(req.url).origin;
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : requestOrigin);

  const res = await fetch(`${baseUrl}/api/cron/followups`, {
    method: "GET",
    headers: { Authorization: `Bearer ${cronSecret}` },
    cache: "no-store",
  });

  const payload = await res.json().catch(() => ({ error: "Invalid cron response" }));
  return NextResponse.json(payload, { status: res.status });
}
