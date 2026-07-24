import { NextRequest, NextResponse } from "next/server";
import { q, getCampaign, logEvent } from "@/lib/db";

/** De noodrem. De worker leest deze status vóór elke ronde. */
export async function POST(req: NextRequest) {
  const { action, by } = await req.json();

  const next = {
    start: "running",
    pause: "paused",   // lopende gesprekken maken we af
    stop: "stopped",   // lopende gesprekken breken we af
    resume: "running",
  }[action as string];

  if (!next) {
    return NextResponse.json({ error: "Onbekende actie" }, { status: 400 });
  }

  await q(`update campaign set status = $1, updated_at = now() where id = 1`, [next]);
  await logEvent("campaign_" + action, { by: by ?? "dashboard" });

  return NextResponse.json(await getCampaign());
}

export async function GET() {
  return NextResponse.json(await getCampaign());
}
