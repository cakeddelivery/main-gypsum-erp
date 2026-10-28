import { Prisma } from "@prisma/client";
import { prisma } from "./db";

type Actor = { actorId?: string | null; actorName?: string | null } | { id: string; name: string } | null;
type Tx = Prisma.TransactionClient | typeof prisma;

function toJson(data: unknown): Prisma.InputJsonValue | undefined {
  if (data === undefined) return undefined;
  return JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
}

/** Tulis audit log (append-only). */
export async function audit(actor: Actor, action: string, entity: string, entityId?: string | null, data?: unknown, tx: Tx = prisma) {
  const a = actor && "id" in actor ? { actorId: actor.id, actorName: actor.name } : (actor ?? {});
  await tx.auditLog.create({
    data: { actorId: a.actorId ?? null, actorName: a.actorName ?? null, action, entity, entityId: entityId ?? null, data: toJson(data) },
  });
}
