import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApi } from "@/lib/apiAuth";

export async function GET(req: Request) {
  const a = await authenticateApi(req, "finance:read");
  if (a.error) return a.error;
  const rows = await prisma.bankAccount.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  return NextResponse.json({ data: rows.map((b) => ({ id: b.id, code: b.code, name: b.name, aliases: b.aliases.split(",").filter(Boolean) })) });
}
