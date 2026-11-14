import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { COA } from "@/lib/accounting";
import { locationSettings, qtyAt, recordMovement } from "@/lib/stock";
import { cancelReturn, claimPaid, claimRejected, COA_KLAIM, COA_RETUR_RUSAK, createReturn, finishReturn, inspectReturn, submitClaim, updateReturn, CLAIM_CATEGORY } from "@/lib/returns";
import { returnMediaMaintenance } from "@/lib/returnJobs";
import { mediaStore } from "@/lib/mediaStore";
import { effectivePermissions } from "@/lib/rbac";
import { runConsistency } from "@/lib/consistency";
import { jakartaDateTime } from "@/lib/time";

let actor: { id: string; name: string };
let finished: string;
let seller: string;
const d = (s: string) => jakartaDateTime(s, "10:00");
/** Saldo (debit − kredit) akun dari jurnal retur (+ pembaliknya) */
async function net(code: string, number: string) {
  const js = await prisma.journal.findMany({ where: { source: "RETUR", sourceId: { startsWith: number } } });
  const rev = await prisma.journal.findMany({ where: { reversalOfId: { in: js.map((j) => j.id) } } });
  const ls = await prisma.journalLine.findMany({ where: { journalId: { in: [...js, ...rev].map((j) => j.id) }, account: { code } } });
  return ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
}
async function product(sku: string, qty: number, cost: number) {
  const it = await prisma.item.create({ data: { sku, name: `Produk ${sku}`, type: "BARANG_JADI", unit: "pcs" } });
  await prisma.$transaction((tx) => recordMovement(tx, { type: "HASIL_PRODUKSI", itemId: it.id, qty, toLocationId: finished, unitCost: cost, date: d("2027-07-01") }, actor));
  return it;
}

beforeAll(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { username: "owner" } });
  actor = { id: u.id, name: u.name };
  finished = (await locationSettings(prisma)).finished!;
  const mp = await prisma.bankAccount.findFirst({ where: { marketplace: true } });
  seller = (mp ?? (await prisma.bankAccount.findUniqueOrThrow({ where: { code: "SEABANK" } }))).id;
});

describe("Retur paket marketplace", () => {
  it("izin retur.manage: Supervisor, Admin Marketplace, Admin, Finance, Owner; bukan Operator", () => {
    for (const r of ["OWNER", "FINANCE", "ADMIN", "ADMIN_MARKETPLACE", "SUPERVISOR"] as const) expect(effectivePermissions(r, []).has("retur.manage")).toBe(true);
    for (const r of ["OPERATOR", "KAPTEN_DIVISI", "KOORDINATOR"] as const) expect(effectivePermissions(r, []).has("retur.manage")).toBe(false);
  });

  it("catat → periksa: barang baik kembali ke stok, rusak/hilang ke Kerugian Retur, HPP dikoreksi; resi ganda ditolak", async () => {
    const a = await product("RTR-A", 20, 5000);
    const b = await product("RTR-B", 5, 7000);
    const r = await createReturn({ receivedAt: d("2027-07-02"), marketplace: "SHOPEE", courier: "SPX", trackingNo: "spxid0541000001", city: "Kab. Lamongan", province: "Jawa Timur", lines: [{ labelSku: "GIFT-MIX", labelVariation: "STANDARD,MIX", qty: 12, itemId: a.id }, { labelSku: "MG-24HWN", qty: 2, itemId: b.id }] }, actor);
    expect(r.trackingNo).toBe("SPXID0541000001");
    expect(r.number).toMatch(/^RTR-\d{6}-\d{4}$/);
    await expect(createReturn({ receivedAt: d("2027-07-02"), trackingNo: "SPXID0541000001", lines: [{ labelSku: "X", qty: 1 }] }, actor)).rejects.toThrow(/sudah tercatat/);
    // SKU yang dikonfirmasi dipelajari
    expect((await prisma.marketplaceSkuMap.findUnique({ where: { key: "GIFT-MIX|STANDARD,MIX" } }))?.itemId).toBe(a.id);

    const lines = await prisma.returnLine.findMany({ where: { returnId: r.id }, orderBy: { sortOrder: "asc" } });
    const before = await qtyAt(prisma, a.id, finished);
    const x = await inspectReturn(r.id, [{ lineId: lines[0].id, goodQty: 8, damagedQty: 3 }, { lineId: lines[1].id, goodQty: 2, damagedQty: 0 }], actor, d("2027-07-03"));
    expect(x.status).toBe("DIPERIKSA");
    expect(Number(x.goodValue)).toBe(8 * 5000 + 2 * 7000);
    expect(Number(x.lossValue)).toBe(4 * 5000);
    expect(await qtyAt(prisma, a.id, finished)).toBe(before + 8);
    expect(await net(COA.PERSEDIAAN_JADI, r.number)).toBe(54000);
    expect(await net(COA_RETUR_RUSAK, r.number)).toBe(20000);
    expect(await net(COA.HPP, r.number)).toBe(-74000);

    // Periksa ulang: hasil lama dibalik, tidak dobel
    const y = await inspectReturn(r.id, [{ lineId: lines[0].id, goodQty: 10, damagedQty: 2 }, { lineId: lines[1].id, goodQty: 2, damagedQty: 0 }], actor, d("2027-07-03"));
    expect(Number(y.lossValue)).toBe(10000);
    expect(await qtyAt(prisma, a.id, finished)).toBe(before + 10);
    expect(await net(COA.PERSEDIAAN_JADI, r.number)).toBe(64000);
    expect(await net(COA_RETUR_RUSAK, r.number)).toBe(10000);
    await expect(updateReturn(r.id, { receivedAt: d("2027-07-02"), trackingNo: "SPXID0541000001", lines: [{ labelSku: "X", qty: 1 }] }, actor)).rejects.toThrow(/sudah diperiksa/);

    // Klaim → cair: pemasukan tertaut di Transaksi (kategori Klaim Retur Marketplace)
    await submitClaim(r.id, 10000, "tiket 123", actor);
    await expect(inspectReturn(r.id, [], actor, d("2027-07-03"))).rejects.toThrow(/tidak bisa diubah/);
    const c = await claimPaid(r.id, { amount: 10000, bankAccountId: seller, date: d("2027-07-10") }, actor);
    expect(c.status).toBe("KLAIM_CAIR");
    expect(await net(COA_KLAIM, r.number)).toBe(-10000);
    const tx = await prisma.financeTransaction.findFirstOrThrow({ where: { journalId: c.claimJournalId! } });
    expect(tx).toMatchObject({ origin: "RETUR", direction: "MASUK", status: "DIBUKUKAN" });
    expect(Number(tx.amount)).toBe(10000);
    const cat = await prisma.txCategory.findFirstOrThrow({ where: { name: CLAIM_CATEGORY } });
    expect(tx.categoryId).toBe(cat.id);
    const done = await finishReturn(r.id, actor, d("2027-07-11"));
    expect(done.status).toBe("SELESAI");
  });

  it("klaim ditolak lalu selesai; batal membalik semua (stok & jurnal)", async () => {
    const a = await product("RTR-C", 4, 3000);
    const r = await createReturn({ receivedAt: d("2027-07-04"), trackingNo: "JX9990001112", lines: [{ labelSku: "C", qty: 3, itemId: a.id }] }, actor);
    const [l] = await prisma.returnLine.findMany({ where: { returnId: r.id } });
    await expect(finishReturn(r.id, actor)).rejects.toThrow(/Periksa/);
    await inspectReturn(r.id, [{ lineId: l.id, goodQty: 1, damagedQty: 2 }], actor, d("2027-07-05"));
    await submitClaim(r.id, 6000, null, actor);
    await claimRejected(r.id, "tanpa video", actor);
    await cancelReturn(r.id, "salah input", actor, d("2027-07-06"));
    expect(await qtyAt(prisma, a.id, finished)).toBe(4);
    for (const code of [COA.PERSEDIAAN_JADI, COA_RETUR_RUSAK, COA.HPP]) expect(await net(code, r.number)).toBe(0);
    // Resi yang dibatalkan boleh dicatat lagi
    await expect(createReturn({ receivedAt: d("2027-07-06"), trackingNo: "JX9990001112", lines: [{ labelSku: "C", qty: 3, itemId: a.id }] }, actor)).resolves.toBeTruthy();
  });

  it("barang belum dipetakan harus dipilih dulu sebelum diperiksa", async () => {
    const r = await createReturn({ receivedAt: d("2027-07-04"), trackingNo: "SPXID0541000099", lines: [{ labelSku: "BBWP", labelName: "Bubble + Dus", qty: 1 }] }, actor);
    await expect(inspectReturn(r.id, [], actor, d("2027-07-05"))).rejects.toThrow(/Pilih barang ERP/);
  });

  it("video dihapus otomatis 60 hari setelah Selesai; unggahan macet ditandai gagal & muncul di Cek konsistensi", async () => {
    const r = await prisma.returnCase.findFirstOrThrow({ where: { status: "SELESAI" } });
    const key = mediaStore.newKey("retur-test", "mp4");
    await mediaStore.write(key, Buffer.alloc(1000, 1));
    const thumbKey = mediaStore.newKey("retur-test", "jpg");
    await mediaStore.write(thumbKey, Buffer.alloc(100, 1));
    const v = await prisma.returnMedia.create({ data: { returnId: r.id, kind: "VIDEO", status: "READY", storageKey: key, mime: "video/mp4", size: 1000, createdBy: "t" } });
    const t = await prisma.returnMedia.create({ data: { returnId: r.id, kind: "THUMB", status: "READY", storageKey: thumbKey, mime: "image/jpeg", size: 100, createdBy: "t" } });
    const open = await prisma.returnCase.findFirstOrThrow({ where: { status: "DITERIMA", cancelledAt: null } });
    const stuckKey = mediaStore.newKey("retur-test", "webm");
    await mediaStore.append(stuckKey, Buffer.alloc(500, 1), 0);
    const stuck = await prisma.returnMedia.create({ data: { returnId: open.id, kind: "VIDEO", status: "UPLOADING", storageKey: stuckKey, mime: "video/webm", received: 500, createdBy: "t" } });
    await prisma.$executeRaw`UPDATE "ReturnMedia" SET "updatedAt" = now() - interval '3 days' WHERE id = ${stuck.id}`;

    const early = await returnMediaMaintenance(new Date(r.doneAt!.getTime() + 59 * 86_400_000));
    expect(early.deleted).toBe(0);
    expect(early.failed).toBe(1);
    const res = await returnMediaMaintenance(new Date(r.doneAt!.getTime() + 61 * 86_400_000));
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.returnMedia.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ status: "DELETED", storageKey: null });
    expect(await mediaStore.size(key)).toBe(0);
    expect((await prisma.returnMedia.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("READY");
    expect(await mediaStore.size(thumbKey)).toBe(100);
    expect((await prisma.returnMedia.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("FAILED");
    const c = await runConsistency(d("2027-09-30"));
    expect(c.issues.find((i) => i.key === "video-retur-gagal")?.items.length).toBeGreaterThan(0);
    expect(c.issues.find((i) => i.key === "retur-menggantung")?.items.length).toBeGreaterThan(0);
  });
});
