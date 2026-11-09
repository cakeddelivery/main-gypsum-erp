import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { approveAndBook, changeBookedStore, createTransaction, WITHDRAW_INCOME_SOURCE, withdrawIncomeLines } from "@/lib/finance";
import { postJournal } from "@/lib/accounting";
import { jakartaDateTime } from "@/lib/time";
import { activeDuplicateJournals } from "@/lib/auditChecks";

describe("Audit: jurnal ganda yang masih aktif", () => {
  it("ganti toko (jurnal dibalik) tidak dihitung; pemasukan dobel yang belum dibalik tetap terdeteksi", async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    const actor = { id: u.id, name: u.name };
    const [mg, dl] = await Promise.all([prisma.store.findUniqueOrThrow({ where: { code: "MG" } }), prisma.store.findUniqueOrThrow({ where: { code: "DL" } })]);
    const seller = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SALDO_SHOPEE" } });
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const start = jakartaDateTime("2026-11-20", "00:00");
    const amt = 512_000 + (Date.now() % 777);
    const { transaction } = await createTransaction({ direction: "TRANSFER", amount: amt, date: jakartaDateTime("2026-11-21", "09:00"), accountId: seller.id, toAccountId: bank.id, storeId: mg.id }, "MANUAL", actor, { submit: true });
    await approveAndBook(transaction.id, actor);
    // Ganti toko: jurnal lama dibalik & dicatat ulang (dulu muncul sebagai "jurnal ganda")
    await changeBookedStore(transaction.id, dl.id, actor);
    expect((await activeDuplicateJournals(prisma, start)).filter((g) => g.sourceId === transaction.id)).toEqual([]);


    // Pemasukan dobel yang belum dibalik: terdeteksi
    const dup = await prisma.$transaction((tx) => postJournal(tx, { date: transaction.date, storeId: dl.id, description: "uji pemasukan dobel", source: WITHDRAW_INCOME_SOURCE, sourceId: transaction.id, actor, lines: withdrawIncomeLines(seller.coaAccountId, seller.name, amt) }));
    const found = (await activeDuplicateJournals(prisma, start)).filter((x) => x.sourceId === transaction.id);
    // Jurnal transaksinya sendiri sudah berisi pemasukan penjualan, jadi pemasukan susulan = penjualan dobel
    expect(found.find((x) => x.kind === "PENJUALAN_WD")?.numbers).toContain(dup.number);
  });
});
