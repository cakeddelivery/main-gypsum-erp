import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA, postJournal } from "@/lib/accounting";
import { canReverseFromJournal, reverseFromJournalMenu, sourceHref } from "@/lib/journalSource";
import { jakartaDateTime } from "@/lib/time";

const actor = { id: "system", name: "uji" };
const date = jakartaDateTime("2026-11-20", "10:00");
const post = (source: string, sourceId: string | null = null) =>
  prisma.$transaction((tx) =>
    postJournal(tx, { date, storeId: null, description: `uji balik ${source}`, source, sourceId, actor, lines: [{ accountCode: COA.BEBAN_LAIN, debit: 1000 }, { accountCode: COA.KAS, credit: 1000 }] }),
  );
const balik = (id: string) => prisma.$transaction((tx) => reverseFromJournalMenu(tx, id, date, actor, "uji"));

describe("Tombol Balik di Jurnal umum", () => {
  it("hanya jurnal MANUAL / PENYESUAIAN / SALDO_AWAL yang bisa dibalik", () => {
    for (const s of ["MANUAL", "PENYESUAIAN", "SALDO_AWAL"]) expect(canReverseFromJournal({ source: s, reversalOfId: null })).toBe(true);
    for (const s of ["FINANCE", "PEMBELIAN", "PAYROLL", "PENJUALAN", "SISIHAN", "WITHDRAW_PENJUALAN", "WD_DITERIMA", "KASBON", "STOK"]) expect(canReverseFromJournal({ source: s, reversalOfId: null })).toBe(false);
    expect(canReverseFromJournal({ source: "MANUAL", reversalOfId: "x" })).toBe(false);
    expect(sourceHref("FINANCE", "trx1")).toBe("/finance/trx1");
    expect(sourceHref("PENJUALAN", "JUAL-1", "sale1")).toBe("/penjualan/sale1");
  });

  it("server menolak jurnal dari menu lain & jurnal pembalik; jurnal manual dibalik sekali saja", async () => {
    const fin = await post("FINANCE", "trx-uji");
    await expect(balik(fin.id)).rejects.toThrow(/menu Transaksi/);
    expect(await prisma.journal.count({ where: { reversalOfId: fin.id } })).toBe(0);

    const man = await post("MANUAL");
    const rev = await balik(man.id);
    expect(rev.source).toBe("PEMBALIK");
    await expect(balik(man.id)).rejects.toThrow(/sudah pernah dibalik/);
    await expect(balik(rev.id)).rejects.toThrow(/jurnal pembalik/);
  });
});
