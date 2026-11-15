import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA } from "@/lib/accounting";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { approveRefund, cancelComplaint, canSeePayee, COA_GARANSI, COA_REFUND, createComplaint, finishComplaint, payRefund, rejectComplaint, sendReplacement, validateComplaint, REFUND_CATEGORY, type ComplaintInput } from "@/lib/complaints";
import { effectivePermissions, sensitiveGrants } from "@/lib/rbac";
import { runConsistency } from "@/lib/consistency";
import { jakartaDateTime } from "@/lib/time";

let owner: { id: string; name: string; role: string };
let finance: { id: string; name: string; role: string };
let spv: { id: string; name: string; role: string };
let finished: string;
let seabank: string;
const d = (s: string) => jakartaDateTime(s, "10:00");
async function net(code: string, number: string) {
  const js = await prisma.journal.findMany({ where: { source: "KOMPLAIN", sourceId: { startsWith: number } } });
  const rev = await prisma.journal.findMany({ where: { reversalOfId: { in: js.map((j) => j.id) } } });
  const ls = await prisma.journalLine.findMany({ where: { journalId: { in: [...js, ...rev].map((j) => j.id) }, account: { code } } });
  return ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
}
const base = (x: Partial<ComplaintInput>): ComplaintInput => ({ date: d("2027-08-01"), orderNo: "2508017ABCDE12", issueType: "PECAH", solution: "REFUND", refundAmount: 50000, payeeBank: "ShopeePay", payeeAccount: "0812 3456 7890", payeeName: "Pembeli Uji", lines: [{ labelSku: "MG-24HWN", qty: 4 }], ...x });
const asUser = (u: { id: string; role: string }) => ({ ...u, can: (p: string) => effectivePermissions(u.role as never, []).has(p as never) });

beforeAll(async () => {
  const pick = async (username: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { username } });
    return { id: u.id, name: u.name, role: u.role as string };
  };
  owner = await pick("owner");
  finance = await pick("finance");
  const s = await prisma.user.findFirst({ where: { role: "SUPERVISOR" } });
  spv = s ? { id: s.id, name: s.name, role: s.role } : { id: "spv-x", name: "Supervisor Uji", role: "SUPERVISOR" };
  finished = (await locationSettings(prisma)).finished!;
  seabank = (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } })).id;
});

describe("Komplain & refund", () => {
  it("izin: Supervisor ajukan; Finance setujui & bayar; izin refund sensitif", () => {
    expect(effectivePermissions("SUPERVISOR", []).has("refund.request")).toBe(true);
    expect(effectivePermissions("SUPERVISOR", []).has("refund.approve")).toBe(false);
    for (const p of ["refund.approve", "refund.pay"] as const) expect(effectivePermissions("FINANCE", []).has(p)).toBe(true);
    expect(sensitiveGrants("SUPERVISOR", new Set(), new Set(["refund.pay"]))).toEqual(["refund.pay"]);
  });

  it("validasi isian", () => {
    expect(() => validateComplaint(base({ payeeAccount: "" }))).toThrow(/rekening/);
    expect(() => validateComplaint(base({ refundAmount: 0 }))).toThrow(/nominal/);
    expect(() => validateComplaint(base({ orderNo: null, trackingNo: null }))).toThrow(/resi/);
    expect(() => validateComplaint(base({ solution: "KIRIM_GANTI" }))).toThrow(/pengganti/);
  });

  it("refund ≤ batas: Finance setuju → bayar → Transaksi tertaut (Retur & Refund Penjualan) → selesai", async () => {
    const c = await createComplaint(base({}), spv);
    expect(c.payeeAccount).toBe("081234567890");
    // Rekening hanya untuk pengaju, Finance, Owner
    expect(canSeePayee(c, asUser(spv))).toBe(true);
    expect(canSeePayee(c, asUser({ id: "lain", role: "SUPERVISOR" }))).toBe(false);
    expect(canSeePayee(c, asUser({ id: "x", role: "FINANCE" }))).toBe(true);
    await expect(payRefund(c.id, { bankAccountId: seabank, date: d("2027-08-02"), proofPath: "x.jpg", proofMime: "image/jpeg" }, finance)).rejects.toThrow(/belum disetujui/);
    const a = await approveRefund(c.id, finance);
    expect(a.status).toBe("DISETUJUI");
    const p = await payRefund(c.id, { bankAccountId: seabank, date: d("2027-08-02"), proofPath: "x.jpg", proofMime: "image/jpeg" }, finance);
    expect(p.status).toBe("DIBAYAR");
    expect(await net(COA_REFUND, c.number)).toBe(50000);
    const tx = await prisma.financeTransaction.findFirstOrThrow({ where: { journalId: p.payJournalId! } });
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: REFUND_CATEGORY, direction: "KELUAR" } });
    expect(tx).toMatchObject({ origin: "KOMPLAIN", direction: "KELUAR", status: "DIBUKUKAN", categoryId: cat.id, proofPath: "x.jpg", accountId: seabank });
    expect(Number(tx.amount)).toBe(50000);
    expect((await finishComplaint(c.id, spv)).status).toBe("SELESAI");
    // Audit tidak menyimpan nomor rekening pembeli
    const logs = await prisma.auditLog.findMany({ where: { entityId: c.id } });
    expect(JSON.stringify(logs)).not.toMatch(/081234567890/);
  });

  it("refund > batas: Finance → Menunggu Owner → Owner setuju; Finance tidak bisa melewati Owner", async () => {
    const c = await createComplaint(base({ refundAmount: 150000, orderNo: "2508017ABCDE13" }), spv);
    expect((await approveRefund(c.id, finance)).status).toBe("MENUNGGU_OWNER");
    await expect(approveRefund(c.id, finance)).rejects.toThrow(/Owner/);
    await expect(payRefund(c.id, { bankAccountId: seabank, date: d("2027-08-02"), proofPath: "y.jpg", proofMime: "image/jpeg" }, finance)).rejects.toThrow(/Owner/);
    expect((await approveRefund(c.id, owner)).status).toBe("DISETUJUI");
    // Owner langsung menyetujui refund besar yang baru diajukan
    const c2 = await createComplaint(base({ refundAmount: 200000, orderNo: "2508017ABCDE14" }), spv);
    expect((await approveRefund(c2.id, owner))).toMatchObject({ status: "DISETUJUI", ownerApprovedBy: owner.name });
    const r = await rejectComplaint(c2.id, "pembeli batal", finance);
    expect(r.status).toBe("DITOLAK");
    // Batal setelah dibayar → jurnal balik
    await payRefund(c.id, { bankAccountId: seabank, date: d("2027-08-03"), proofPath: "y.jpg", proofMime: "image/jpeg" }, finance);
    await cancelComplaint(c.id, "salah input", finance, d("2027-08-04"));
    expect(await net(COA_REFUND, c.number)).toBe(0);
    expect((await prisma.financeTransaction.findFirstOrThrow({ where: { origin: "KOMPLAIN", originRef: `${c.number}:REFUND` } })).status).toBe("DIBATALKAN");
  });

  it("kirim ganti: stok barang jadi keluar sebagai Beban Garansi (bukan HPP), batal mengembalikan stok", async () => {
    const it = await prisma.item.create({ data: { sku: "KMP-A", name: "Produk KMP-A", type: "BARANG_JADI", unit: "pcs" } });
    await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: it.id, qty: 10, toLocationId: finished, unitCost: 6000, date: d("2027-08-01") }, owner));
    const c = await createComplaint(base({ solution: "KIRIM_GANTI", bundleNext: true, orderNo: "2508017ABCDE15", lines: [{ itemId: it.id, qty: 4, sendQty: 4 }] }), spv);
    expect(c).toMatchObject({ bundleNext: true, payeeAccount: null, refundAmount: BigInt(0) });
    const s = await sendReplacement(c.id, spv, d("2027-08-05"));
    expect(s.status).toBe("DIKIRIM");
    expect(Number(s.replacementValue)).toBe(24000);
    expect(await qtyAt(prisma, it.id, finished)).toBe(6);
    expect(await net(COA_GARANSI, c.number)).toBe(24000);
    expect(await net(COA.PERSEDIAAN_JADI, c.number)).toBe(-24000);
    expect(await net(COA.HPP, c.number)).toBe(0);
    await cancelComplaint(c.id, "tidak jadi", finance, d("2027-08-06"));
    expect(await qtyAt(prisma, it.id, finished)).toBe(10);
    expect(await net(COA_GARANSI, c.number)).toBe(0);
  });

  it("Cek konsistensi: refund disetujui belum dibayar & komplain menggantung", async () => {
    const c = await createComplaint(base({ orderNo: "2508017ABCDE16" }), spv);
    await approveRefund(c.id, finance);
    await prisma.complaint.update({ where: { id: c.id }, data: { approvedAt: d("2027-08-01") } });
    const old = await createComplaint(base({ orderNo: "2508017ABCDE17" }), spv);
    await prisma.complaint.update({ where: { id: old.id }, data: { createdAt: d("2027-07-01") } });
    const r = await runConsistency(d("2027-08-10"));
    expect(r.issues.find((i) => i.key === "refund-belum-dibayar")?.items.map((i) => i.label)).toContain(c.number);
    expect(r.issues.find((i) => i.key === "komplain-menggantung")?.items.map((i) => i.label)).toContain(old.number);
  });
});
