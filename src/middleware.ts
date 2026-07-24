import { NextRequest, NextResponse } from "next/server";

/**
 * Basic Auth voor het dashboard. Het dashboard toont belgegevens van partners
 * en mag niet publiek zijn. Zet DASHBOARD_USER en DASHBOARD_PASS in de omgeving.
 *
 * (Netlify Identity kan ook, maar Basic Auth volstaat en werkt overal hetzelfde.)
 */
export const config = {
  matcher: ["/dashboard/:path*"],
};

export function middleware(req: NextRequest) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;

  // Geen credentials ingesteld → dashboard dicht, geen stille lek.
  if (!user || !pass) {
    return new NextResponse(
      "Dashboard-authenticatie is niet geconfigureerd (DASHBOARD_USER / DASHBOARD_PASS).",
      { status: 503 },
    );
  }

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    const u = decoded.slice(0, sep);
    const p = decoded.slice(sep + 1);
    if (u === user && p === pass) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authenticatie vereist.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Belronde dashboard", charset="UTF-8"',
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
