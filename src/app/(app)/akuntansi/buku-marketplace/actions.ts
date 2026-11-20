"use server";
import { action, int, optStr, str, FieldError } from "@/lib/action";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { glOpenDate, rebuildGl, saldoIklan, saldoPenjual } from "@/lib/marketplace/gl";

const PATHS = ["/akuntansi/buku-marketplace"];

export const rebuildGlAction = action(
  "accounting.post",
  async () => {
    const r = await rebuildGl();
    return `Buku bayangan dibangun ulang: ${r.journals} jurnal (tanggal setelah ${r.openDate})`;
  },
  PATHS,
);

/** Saldo pembuka per toko × kanal × jenis saldo. Hanya memengaruhi BUKU BAYANGAN (tidak ada jurnal nyata). */
export const saveGlOpeningAction = action(
  "accounting.post",
  async (fd, user) => {
    const storeId = str(fd, "storeId"), channel = str(fd, "channel"), wallet = str(fd, "wallet");
    const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
    const ok = wallet === "IKLAN" ? channel === "SHP" && !!saldoIklan(store.code) : wallet === "PENJUAL" && !!saldoPenjual(store.code, channel);
    if (!ok) throw new FieldError("wallet", "Kombinasi toko/kanal/jenis saldo tidak dikenal");
    const amount = int(fd, "amount");
    const asOf = new Date(`${await glOpenDate()}T00:00:00Z`);
    const source = str(fd, "source") === "FILE" ? "FILE" : "MANUAL";
    await prisma.marketplaceGlOpening.upsert({
      where: { storeId_channel_wallet: { storeId, channel, wallet } },
      create: { storeId, channel, wallet, asOf, amount: BigInt(amount), source, note: optStr(fd, "note"), createdBy: user.name },
      update: { asOf, amount: BigInt(amount), source, note: optStr(fd, "note"), createdBy: user.name },
    });
    await audit(user, "MARKETPLACE_SALDO_PEMBUKA", "MarketplaceGlOpening", `${storeId}|${channel}|${wallet}`, { amount, source });
    const r = await rebuildGl();
    return `Saldo pembuka tersimpan (${r.journals} jurnal bayangan dibangun ulang)`;
  },
  PATHS,
);
