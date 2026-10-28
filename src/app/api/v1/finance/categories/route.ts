import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApi } from "@/lib/apiAuth";

export async function GET(req: Request) {
  const a = await authenticateApi(req, "finance:read");
  if (a.error) return a.error;
  const rows = await prisma.txCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  return NextResponse.json({ data: rows.map((c) => ({ id: c.id, name: c.name, direction: c.direction, keywords: c.keywords.split(",").filter(Boolean) })) });
}
