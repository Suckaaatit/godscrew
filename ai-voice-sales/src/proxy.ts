import { NextRequest, NextResponse } from "next/server";

function unauthorizedResponse() {
  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="GodsCrew Dashboard", charset="UTF-8"',
    },
  });
}

function readBasicAuth(req: NextRequest) {
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  const encoded = header.slice("Basic ".length).trim();
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      user: decoded.slice(0, separator),
      pass: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function hasValidBasicAuth(req: NextRequest) {
  const expectedUser = process.env.DASHBOARD_BASIC_USER?.trim();
  const expectedPass = process.env.DASHBOARD_BASIC_PASS?.trim() ?? "";
  if (!expectedUser) return false;

  const creds = readBasicAuth(req);
  if (!creds) return false;
  return creds.user === expectedUser && creds.pass === expectedPass;
}

export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const isCronRoute = pathname === "/api/cron/followups";
  const isProtectedRoute =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/api/dashboard") ||
    pathname.startsWith("/api/internal");

  // Allow Vercel Cron with bearer secret for followups endpoint.
  if (isCronRoute) {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret) {
      const authHeader = req.headers.get("authorization") || "";
      if (authHeader === `Bearer ${cronSecret}`) {
        return NextResponse.next();
      }
    }
    if (!hasValidBasicAuth(req)) {
      return unauthorizedResponse();
    }
    return NextResponse.next();
  }

  if (isProtectedRoute && !hasValidBasicAuth(req)) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/api/dashboard/:path*",
    "/api/internal/:path*",
    "/api/cron/followups",
  ],
};
