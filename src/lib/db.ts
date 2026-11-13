import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };

/** PRISMA_PROFILE=1: catat setiap query + durasinya ke log (untuk mengukur halaman lambat; mati secara default) */
function create() {
  if (process.env.PRISMA_PROFILE !== "1") return new PrismaClient();
  const c = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  c.$on("query", (e) => console.log(`[q] ${e.duration}ms ${e.query.slice(0, 160).replace(/\s+/g, " ")}`));
  return c;
}

export const prisma = g.prisma ?? create();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;

// BigInt (IDR) aman di-serialisasi ke JSON
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};
