import { NextResponse } from "next/server";
import { authenticateApi } from "@/lib/apiAuth";
import { dailyRecapText } from "@/lib/jobs";

export async function GET(req: Request) {
  const a = await authenticateApi(req, "finance:read");
  if (a.error) return a.error;
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: { code: "invalid_date", message: "Format YYYY-MM-DD" } }, { status: 400 });
  return NextResponse.json({ data: { text: await dailyRecapText(new Date(), date) } });
}
