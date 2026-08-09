import { NextRequest, NextResponse } from "next/server";
import { q, one, logEvent } from "@/lib/db";

/**
 * De partner klikt "Ja, dit klopt" in de bevestigingsmail.
 * Pas hier gaat de status naar 'verified' — en pas dat telt voor de partnerbijdrage.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("t");
  const edit = req.nextUrl.searchParams.get("edit");
  if (!token) return NextResponse.redirect(new URL("/", req.url));

  const row = await one<{ partner_id: string; token: string }>(
    `select r.partner_id, p.token
       from responses r join partners p on p.id = r.partner_id
      where r.confirm_token = $1`,
    [token],
  );
  if (!row) {
    return new NextResponse("Deze link is niet meer geldig.", { status: 404 });
  }

  if (edit) {
    return NextResponse.redirect(new URL(`/s/${row.token}`, req.url));
  }

  await q(`update responses set confirmed_at = now(), updated_at = now() where confirm_token = $1`, [
    token,
  ]);
  await q(`update partners set status = 'verified', updated_at = now() where id = $1`, [
    row.partner_id,
  ]);
  await logEvent("answers_confirmed", {}, row.partner_id);

  return NextResponse.redirect(new URL(`/s/${row.token}?bevestigd=1`, req.url));
}
