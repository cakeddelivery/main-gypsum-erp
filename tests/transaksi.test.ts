import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { approveAndBook, bankBalances, cancelBookedTransaction, createTransaction } from "@/lib/finance";
import { cashMovements, profitLoss } from "@/lib/accounting";
import { extractTime, extractTransaction, mergeReceipt } from "@/lib/extract";
import { receiptFromOcrText } from "@/lib/ocrReceiptText";
import { jakartaDateTime, txTime } from "@/lib/time";

describe("Jam transaksi", () => {
  it("membaca jam dari teks tanpa tertukar nominal", () => {
    expect(extractTime("bayar listrik jam 14.30")).toBe("14:30");
    expect(extractTime("pukul 9 pagi")).toBe("09:00");
    expect(extractTime("03 Nov 2026 14:32:10")).toBe("14:32");
    expect(extractTime("Waktu 03/11/2026 08.05 WIB")).toBe("08:05");
    expect(extractTime("Rp 10.000 dari seabank")).toBeNull();
    expect(extractTime("nominal 40.00")).toBeNull();
  });
  it("jam sekarang untuk hari ini, 12:00 untuk tanggal lain, jam terbaca diutamakan", () => {
    const now = jakartaDateTime("2026-11-03", "15:07");
    expect(txTime("2026-11-03", null, now)).toBe("15:07");
    expect(txTime("2026-11-01", null, now)).toBe("12:00");
    expect(txTime("2026-11-01", "08:15", now)).toBe("08:15");
    expect(txTime("2026-11-03", "99:00", now)).toBe("15:07");
  });
  it("jam dari bukti transfer (OCR) dipakai bot", () => {
    const now = jakartaDateTime("2026-11-03", "15:00");
    const ocr = receiptFromOcrText("SeaBank\nPembayaran QRIS Berhasil\nRp40.000\nWaktu Transaksi\n03 Nov 2026 11:02:44\nKe SUMBER JAYA", [], now)!;
    expect(ocr.time).toBe("11:02");
    const ex = mergeReceipt(extractTransaction("isi ulang lpg", [], [], now), "isi ulang lpg", ocr, [], [], now);
    expect(ex.date).toBe("2026-11-03");
    expect(ex.time).toBe("11:02");
    // Caption dengan tanggal lain: jam bukti tidak dipakai
    expect(mergeReceipt(extractTransaction("lpg kemarin", [], [], now), "lpg kemarin", ocr, [], [], now).time).toBeNull();
  });
});

describe("Batalkan transaksi dibukukan", () => {
  let actor: { id: string; name: string };
  beforeAll(async () => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
    actor = { id: u.id, name: u.name };
  });
  it("jurnal pembalik mengembalikan saldo & laba rugi, dan tidak dihitung di uang masuk/keluar", async () => {
    const bank = await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } });
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { direction: "KELUAR", active: true } });
    const date = jakartaDateTime("2026-11-03", "11:02");
    const range = { start: jakartaDateTime("2026-11-03", "00:00"), end: jakartaDateTime("2026-11-04", "00:00") };
    const before = (await bankBalances()).find((b) => b.id === bank.id)!.balance;
    const plBefore = (await profitLoss(range)).netProfit;
    const { transaction } = await createTransaction({ direction: "KELUAR", amount: 41_234, date, accountId: bank.id, categoryId: cat.id }, "TELEGRAM", actor);
    await approveAndBook(transaction.id, actor);
    expect((await bankBalances()).find((b) => b.id === bank.id)!.balance).toBe(before - 41_234);
    await expect(cancelBookedTransaction(transaction.id, actor, "")).rejects.toThrow(/Alasan/);
    const { reversal } = await cancelBookedTransaction(transaction.id, actor, "uji coba");
    expect(reversal.date.getTime()).toBe(date.getTime());
    expect((await bankBalances()).find((b) => b.id === bank.id)!.balance).toBe(before);
    expect((await profitLoss(range)).netProfit).toBe(plBefore);
    const moves = await cashMovements(range.start, range.end);
    expect(moves.some((m) => m.memo.includes(transaction.number))).toBe(false);
    expect((await prisma.financeTransaction.findUniqueOrThrow({ where: { id: transaction.id } })).status).toBe("DIBATALKAN");
    await expect(cancelBookedTransaction(transaction.id, actor, "lagi")).rejects.toThrow(/Dibukukan/);
    // Transaksi dibatalkan tidak lagi memicu peringatan duplikat
    const again = await createTransaction({ direction: "KELUAR", amount: 41_234, date, accountId: bank.id, categoryId: cat.id }, "TELEGRAM", actor);
    expect(again.duplicate).toBeNull();
  });
});
