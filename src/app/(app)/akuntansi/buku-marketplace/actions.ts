"use server";
import { action, int, optStr, str, FieldError } from "@/lib/action";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { glOpenDate, openingFromBalance, rebuildGl, saldoIklan, saldoPenjual, type Wallet } from "@/lib/marketplace/gl";

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
    let amount = int(fd, "amount");
    const openDate = await glOpenDate();
    const asOf = new Date(`${openDate}T00:00:00Z`);
    const source = str(fd, "source") === "FILE" ? "FILE" : "MANUAL";
    // saldo diisi PADA tanggal+jam tertentu setelah tanggal pembuka → dihitung mundur ke tanggal pembuka
    const day = optStr(fd, "asOfDate"), time = optStr(fd, "asOfTime");
    let note = optStr(fd, "note");
    let msg = "Saldo pembuka tersimpan";
    if (day && day > openDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new FieldError("asOfDate", "Tanggal tidak valid");
      if (time && !/^\d{2}:\d{2}$/.test(time)) throw new FieldError("asOfTime", "Jam tidak valid (JJ:MM)");
      const at = new Date(`${day}T${time ?? "23:59"}:59+07:00`);
      if (Number.isNaN(at.getTime())) throw new FieldError("asOfDate", "Tanggal tidak valid");
      if (at.getTime() > Date.now() + 60_000) throw new FieldError("asOfDate", "Tanggal/jam tidak boleh di masa depan");
      const r = await openingFromBalance(storeId, channel, wallet as Wallet, amount, at);
      const idn = (v: number) => v.toLocaleString("id-ID");
      note = `${note ? note + " · " : ""}Dihitung mundur dari saldo ${idn(amount)} pada ${day} ${time ?? "akhir hari"} WIB (mutasi ${r.count} jurnal: ${idn(r.movement)})`;
      msg = `Saldo ${idn(amount)} pada ${day} ${time ?? "akhir hari"} dihitung mundur → pembuka ${idn(r.opening)} (mutasi sesudah ${openDate}: ${idn(r.movement)})`;
      amount = r.opening;
    }
    await prisma.marketplaceGlOpening.upsert({
      where: { storeId_channel_wallet: { storeId, channel, wallet } },
      create: { storeId, channel, wallet, asOf, amount: BigInt(amount), source, note, createdBy: user.name },
      update: { asOf, amount: BigInt(amount), source, note, createdBy: user.name },
    });
    await audit(user, "MARKETPLACE_SALDO_PEMBUKA", "MarketplaceGlOpening", `${storeId}|${channel}|${wallet}`, { amount, source });
    const r = await rebuildGl();
    return `${msg} (${r.journals} jurnal bayangan dibangun ulang)`;
  },
  PATHS,
);
