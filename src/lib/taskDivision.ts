import type { Prisma, PrismaClient } from "@prisma/client";

type DB = Prisma.TransactionClient | PrismaClient;

/** Pemetaan bawaan tugas → divisi pencatat: Assembling & Cat Plastik → Assembling, Cat Giftbox → Giftbox */
export function defaultTaskTemplate(name: string): string | null {
  if (/assembl|cat\s*plastik/i.test(name)) return "ASSEMBLING";
  if (/cat\s*giftbox/i.test(name)) return "GIFTBOX";
  return null;
}

/** Isi divisi bawaan untuk tugas yang belum punya divisi (seed / skrip) */
export async function assignDefaultTaskDivisions(db: DB) {
  const [tasks, divs] = await Promise.all([db.pieceTask.findMany({ where: { divisionId: null } }), db.division.findMany({ where: { reportTemplate: { not: null } } })]);
  let n = 0;
  for (const t of tasks) {
    const d = divs.find((x) => x.reportTemplate === defaultTaskTemplate(t.name));
    if (d) { await db.pieceTask.update({ where: { id: t.id }, data: { divisionId: d.id } }); n++; }
  }
  return n;
}

