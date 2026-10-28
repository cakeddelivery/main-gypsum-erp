import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { apiError, authenticateApi } from "@/lib/apiAuth";
import { extractTransaction } from "@/lib/extract";

export async function POST(req: Request) {
  const a = await authenticateApi(req, "finance:read");
  if (a.error) return a.error;
  const body = z.object({ text: z.string().min(1).max(4000) }).safeParse(await req.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_body", "Body {text} wajib");
  const [banks, cats] = await Promise.all([prisma.bankAccount.findMany({ where: { active: true } }), prisma.txCategory.findMany({ where: { active: true } })]);
  return NextResponse.json({ data: extractTransaction(body.data.text, banks, cats) });
}
