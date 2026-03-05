import { NextRequest, NextResponse } from "next/server";

export function proxy(req: NextRequest) {
  if (req.nextUrl.pathname !== "/api/cron/followups") return NextResponse.next();
  
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") || "";
  if (!cronSecret || authHeader === `Bearer ${cronSecret}`) {
    return NextResponse.next();
  }
  
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export const config = {
  matcher: ["/api/cron/followups"],
};
