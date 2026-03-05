import { NextRequest, NextResponse } from "next/server";

function isProtected(pathname: string) {
  return (
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/api/dashboard") ||
    pathname.startsWith("/api/internal") ||
    pathname === "/api/cron/followups"
  );
}

export function middleware(req: NextRequest) {
  if (!isProtected(req.nextUrl.pathname)) return NextResponse.next();

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization") || "";
  if (req.nextUrl.pathname === "/api/cron/followups" && cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return NextResponse.next();
  }

  const user = process.env.DASHBOARD_BASIC_USER;
  const pass = process.env.DASHBOARD_BASIC_PASS;
  if (!user || !pass) {
    return NextResponse.json({ error: "Dashboard auth not configured" }, { status: 500 });
  }

  if (authHeader.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice(6));
    const [u, p] = decoded.split(":");
    if (u === user && p === pass) return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Dashboard"' },
  });
}

export const config = {
  matcher: ["/dashboard/:path*", "/api/dashboard/:path*", "/api/internal/:path*", "/api/cron/followups"],
};
