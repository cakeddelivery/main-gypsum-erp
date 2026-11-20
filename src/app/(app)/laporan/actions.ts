"use server";
import { autoRequestsFromReport } from "@/lib/stockRequestAuto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { action, str, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { dateOnly, fmtDay } from "@/lib/time";
import { assertPerm, ForbiddenError } from "@/lib/auth";
import { canSeeDivision, canFollowUp, reportDivision } from "@/lib/reportScope";
import { sendTelegram, telegramConfigured, esc } from "@/lib/telegram";
import { STAGE_LABEL } from "@/lib/stock";
import { applyShiftStockCount } from "@/lib/shiftReportStock";
import { postShiftWork } from "@/lib/shiftReportFlow";
import { assertMemberOwnsReport, memberReportSlot, moveReportShift, discardEmptyDraft } from "@/lib/reportShift";
import { REJECT_KEY, REJECT_REASONS, applyReportRejects, parseRejects, storedRejects } from "@/lib/productionReject";
import { boronganBalanceLines, saveShiftBalance } from "@/lib/shiftBalance";
import { LPG_KEY, applyLpg, parseLpg, storedLpg as storedLpgFor } from "@/lib/lpg";
import { SAMPLE_KEY, SAMPLE_PLATFORMS, applyReportSamples, isSampleTemplate, parseSamples, storedSamples } from "@/lib/affiliateSample";
import { sendShiftReportJpg } from "@/lib/shiftReportJpg";
import { boronganLines } from "@/lib/shiftReportBorongan";
import { receiptReportLines } from "@/lib/boronganReceipt";
import { saveProof } from "@/lib/storage";
import { divisionChecklist, refreshDraftChecklists } from "@/lib/shiftReportChecklist";
import { addShiftReceipt, addShiftReceipts, removeShiftReceipt } from "@/lib/shiftReceipt";
import { RESULT_KEY, applyResultCount, parseResultCount, resultCountStatus, resultItems, resultLines } from "@/lib/shiftResultCount";
import { reportCatalogs } from "@/lib/productFamily";
import { withCurrentLimits } from "@/lib/shiftReportStock";
import { isDone, isTemplate, needsOrder, parseWork, summaryOf, targetLine, targetOf, toEntries, workLines, type ChecklistEntry, type StockCountRow } from "@/lib/shiftReport";


type User = Awaited<ReturnType<typeof assertPerm>>;

/** Karyawan (kapten, operator, akun tertaut karyawan) hanya boleh melaporkan divisinya sendiri */
function guardDivision(user: User, divisionId: string) {
  if (!canSeeDivision(user, divisionId)) throw new ForbiddenError();
}

/** Daftar bahan baku divisi untuk stok akhir shift; hitungan lama dipertahankan */
async function stockRows(divisionId: string, prev: StockCountRow[] = []): Promise<StockCountRow[]> {
  const items = await prisma.item.findMany({ where: { divisionId, active: true, type: "BAHAN_BAKU" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return items.map((i) => ({ itemId: i.id, name: i.name, unit: i.unit, limit: Number(i.minStock), qty: prev.find((p) => p.itemId === i.id)?.qty ?? null }));
}

/** "+ Kirim laporan": buat draf (atau buka yang sudah ada) lalu langsung buka form isiannya di popup */
export const openReport = action("report.create", async (fd, user) => {
  let date = str(fd, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Tanggal tidak valid");
  let shiftId = str(fd, "shiftId");
  const divisionId = str(fd, "divisionId");
  guardDivision(user, divisionId);
  // Anggota divisi 2 shift: tanggal & shift laporan OTOMATIS dari absennya (tidak bisa memilih shift lain);
  // Supervisor/Owner/Admin boleh memilih manual (pembuatan laporan baru dicatat di audit).
  const member = reportDivision(user) !== null && user.employeeId;
  if (member) {
    const slot = await memberReportSlot(user.employeeId!, divisionId);
    if (slot) ({ date, shiftId } = { date: slot.date, shiftId: slot.shiftId });
  }
  const division = await prisma.division.findUniqueOrThrow({ where: { id: divisionId } });
  const allowed = (await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, take: Math.max(1, division.shiftCount) })).map((s) => s.id);
  if (!allowed.includes(shiftId)) throw new Error(`${division.name} hanya punya ${division.shiftCount} shift`);
  const checklist = await divisionChecklist(division);
  const existed = await prisma.shiftReport.findUnique({ where: { date_shiftId_divisionId: { date: dateOnly(date), shiftId, divisionId } }, select: { id: true } });
  const r = await prisma.shiftReport.upsert({
    where: { date_shiftId_divisionId: { date: dateOnly(date), shiftId, divisionId } },
    create: {
      date: dateOnly(date),
      shiftId,
      divisionId,
      createdBy: user.name,
      // PIC = username akun yang membuat/mengisi laporan (tidak bisa diketik)
      picName: user.username,
      checklist,
      stockCount: await stockRows(divisionId),
    },
    update: {},
  });
  if (!member && !existed) await audit(user, "LAPORAN_SHIFT_MANUAL", "ShiftReport", r.id, { shiftId, tanggal: date });
  // Draf lama mengikuti checklist divisi terbaru (jawaban dengan label sama dipertahankan)
  await refreshDraftChecklists({ id: r.id });
  // go=masuk: popup Barang masuk; go=terima: popup Penerimaan borongan (dari notifikasi); selain itu form isian laporan
  const go = fd.get("go");
  redirect(`/laporan/${r.id}?${go === "masuk" ? "masuk" : go === "terima" ? "terima" : "isi"}=1`);
});

async function guardReport(id: string, user: User) {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id }, include: { division: true, shift: true } });
  guardDivision(user, r.divisionId);
  // Anggota divisi 2 shift hanya mengisi laporan shift & tanggal absennya sendiri
  if (reportDivision(user) !== null && user.employeeId) await assertMemberOwnsReport(user.employeeId, r);
  return r;
}

/** Anggota divisi tidak boleh mengubah laporan yang sudah terkirim (Supervisor/Admin/Owner boleh) */
async function guardEditable(id: string, user: User) {
  const r = await guardReport(id, user);
  if (r.status !== "DRAFT" && reportDivision(user) !== null) throw new Error("Laporan yang sudah terkirim hanya bisa diubah Supervisor/Admin");
  return r;
}

const num = (s: string) => {
  const t = s.replace(/\./g, "").replace(/,/g, ".");
  if (!t) return null;
  const x = Number(t);
  if (!Number.isFinite(x) || x < 0) throw new Error("Jumlah stok tidak valid");
  return x;
};

/** "Tutup tanpa simpan": hapus draf yang dibuat saat form dibuka bila belum pernah berisi data tersimpan */
export async function discardOpenedDraft(fd: FormData): Promise<{ ok: boolean; deleted?: boolean; error?: string }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    await guardReport(id, user);
    const deleted = await discardEmptyDraft(id, user);
    if (deleted) revalidatePath("/laporan");
    return { ok: true, deleted };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal" };
  }
}

/** Simpan isian laporan (draf). Dipakai tombol "Simpan draf" dan sebelum "Kirim laporan" */
async function saveReportData(fd: FormData, user: User) {
  {
    const id = str(fd, "id");
    const r = await guardEditable(id, user);
    const checklist = toEntries(r.checklist).map((c, i) => ({ ...c, done: c.photo ? !!c.photoPath : fd.get(`check_${i}`) === "on" }));
    const template = r.division.reportTemplate;
    const get = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : null);
    const work: Record<string, unknown> = isTemplate(template) ? parseWork(template, get, await reportCatalogs(template)) : {};
    const rc = parseResultCount((await resultItems(r.divisionId)).map((i) => i.id), get);
    if (rc) work[RESULT_KEY] = rc;
    // Reject per tahap (jenis + jumlah + alasan); tanpa penanda form → reject lama dipertahankan
    if (fd.has("rj.present")) work[REJECT_KEY] = parseRejects((k) => fd.getAll(k).map(String));
    else if ((r.work as Record<string, unknown>)?.[REJECT_KEY]) work[REJECT_KEY] = (r.work as Record<string, unknown>)[REJECT_KEY];
    // LPG (format Produksi/Oven): jumlah tabung penuh/aktif/kosong + isi ulang; tanpa penanda form → data lama dipertahankan
    if (template === "PRODUKSI") {
      if (fd.has("lpg.present")) { const l = parseLpg(get); if (l) work[LPG_KEY] = l; }
      else if ((r.work as Record<string, unknown>)?.[LPG_KEY]) work[LPG_KEY] = (r.work as Record<string, unknown>)[LPG_KEY];
    }
    // Sample affiliator (Packing/Giftbox): produk + jumlah + platform + toko; tanpa penanda form → data lama dipertahankan
    if (isSampleTemplate(template)) {
      if (fd.has("sm.present")) work[SAMPLE_KEY] = parseSamples((k) => fd.getAll(k).map(String));
      else if ((r.work as Record<string, unknown>)?.[SAMPLE_KEY]) work[SAMPLE_KEY] = (r.work as Record<string, unknown>)[SAMPLE_KEY];
    }
    const stock = (await stockRows(r.divisionId, r.stockCount as StockCountRow[])).map((row) => (fd.has(`s.${row.itemId}`) ? { ...row, qty: num(str(fd, `s.${row.itemId}`)) } : row));
    await prisma.shiftReport.update({
      where: { id },
      data: {
        checklist,
        work: work as Prisma.InputJsonValue,
        stockCount: stock,
        picName: user.username,
        complaints: optStr(fd, "complaints"),
        // Tindak lanjut diisi Supervisor/Finance/Owner lewat tombol sendiri (saveFollowUp), bukan di form laporan
        status: r.status === "TERKIRIM" ? "DIREVISI" : r.status,
      },
    });
    await audit(user, "LAPORAN_DIUBAH", "ShiftReport", id);
    return "Draf laporan tersimpan";
  }
}

/** Satu form di popup: intent=draft → simpan saja; intent=send → simpan lalu langsung kirim */
export const saveReport = action(
  "report.create",
  async (fd, user) => {
    const saved = await saveReportData(fd, user);
    if (fd.get("intent") === "send") return sendReportData(str(fd, "id"), user);
    return saved;
  },
  ["/laporan", "/", "/stok"],
);

/** Unggah foto bukti satu tugas checklist (dipanggil langsung dari form, foto sudah dikecilkan di HP) */
export async function uploadChecklistPhoto(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    const index = Number(str(fd, "index"));
    const file = fd.get("photo");
    if (!(file instanceof File) || file.size === 0) throw new Error("Foto belum dipilih");
    const r = await guardReport(id, user);
    const list = toEntries(r.checklist);
    if (!Number.isInteger(index) || !list[index]) throw new Error("Tugas checklist tidak ditemukan");
    const path = await saveProof(Buffer.from(await file.arrayBuffer()), file.type);
    // Baca ulang agar unggahan paralel untuk tugas lain tidak saling menimpa
    await prisma.$transaction(async (tx) => {
      const cur = toEntries((await tx.shiftReport.findUniqueOrThrow({ where: { id } })).checklist);
      cur[index] = { ...cur[index], photoPath: path, done: true };
      await tx.shiftReport.update({ where: { id }, data: { checklist: cur, status: r.status === "TERKIRIM" ? "DIREVISI" : r.status } });
    });
    await audit(user, "FOTO_CHECKLIST", "ShiftReport", id, { task: list[index].label });
    revalidatePath(`/laporan/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal mengunggah foto" };
  }
}

export async function removeChecklistPhoto(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    const index = Number(str(fd, "index"));
    await guardReport(id, user);
    await prisma.$transaction(async (tx) => {
      const cur = toEntries((await tx.shiftReport.findUniqueOrThrow({ where: { id } })).checklist);
      if (!cur[index]) throw new Error("Tugas checklist tidak ditemukan");
      cur[index] = { ...cur[index], photoPath: null, done: false };
      await tx.shiftReport.update({ where: { id }, data: { checklist: cur } });
    });
    revalidatePath(`/laporan/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal menghapus foto" };
  }
}

export const sendReport = action("report.create", async (fd, user) => sendReportData(str(fd, "id"), user), ["/laporan", "/", "/stok"]);

/** Kirim laporan: stok akhir → opname, hasil kerja → stok, pesan Telegram + JPG, riwayat pengiriman */
async function sendReportData(id: string, user: User): Promise<string> {
  {
    await guardEditable(id, user);
    const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id }, include: { shift: true, division: true } });
    // Checklist wajib foto harus lengkap sebelum laporan bisa dikirim
    const noPhoto = toEntries(r.checklist).filter((c) => c.photo && !c.photoPath);
    if (noPhoto.length) throw new Error(`Lampirkan foto dulu: ${noPhoto.map((c) => c.label).join(", ")}`);
    // Stok akhir shift = stock opname bahan baku divisi (per jam selesai shift). Diterapkan dulu: bila gagal
    // (mis. periode sudah ditutup), laporan tidak dikirim agar pesan dan stok tidak berbeda.
    const stockRes = await applyShiftStockCount(id, user);
    // Bahan dengan stok ≤ limit → permintaan stok otomatis (tidak dobel bila masih ada yang terbuka)
    await autoRequestsFromReport(id, user).catch((e) => console.error("Permintaan stok otomatis gagal:", e));
    // Hasil kerja → stok setengah jadi / barang jadi (bila diaktifkan Owner)
    const flowRes = await postShiftWork(id, user);
    // Reject per tahap: dicatat per jenis & alasan; stok keluar + Beban Reject Produksi bila sakelar menyala
    const rejectRes = await applyReportRejects(id, user);
    // Stok akhir setengah jadi / produk jadi milik divisi (sesudah hasil kerja diposting): selisih ditandai; disamakan bila sakelar menyala
    const resultRes = await applyResultCount(id, user);
    const resultStatus = await resultCountStatus(id);
    // Neraca stok per barang (awal + masuk − keluar = sistem vs hitung fisik) disimpan sebagai snapshot; tidak menahan pengiriman bila gagal
    const balance = await saveShiftBalance(id).catch((e) => (console.error("Neraca shift gagal:", e), []));
    // Status tabung LPG + isi ulang menunggu transaksi Finance; tidak menahan pengiriman bila gagal
    const lpgRes = r.division.reportTemplate === "PRODUKSI" ? await applyLpg(id, r.picName).catch((e) => (console.error("LPG gagal:", e), null)) : null;
    // Sample affiliator: dicatat terpisah dari resi penjualan; stok keluar + Beban Promosi & Sample bila sakelar menyala
    const sampleRes = await applyReportSamples(id, user);
    const sampleItems = new Map((await prisma.item.findMany({ where: { id: { in: storedSamples(r.work).map((x) => x.itemId) } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
    const sampleStoreNames = new Map((await prisma.store.findMany({ select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const receipts = await prisma.shiftReceipt.findMany({ where: { reportId: id }, include: { item: true }, orderBy: { number: "asc" } });
    const rejectIds = storedRejects(r.work).map((x) => x.itemId);
    const itemNames = new Map((await prisma.item.findMany({ where: { id: { in: rejectIds } }, select: { id: true, name: true, unit: true } })).map((i) => [i.id, `${i.name}`]));
    const template = r.division.reportTemplate;
    const checklist = toEntries(r.checklist) as ChecklistEntry[];
    const stock = await withCurrentLimits(r.stockCount as StockCountRow[]);
    const order = stock.filter(needsOrder);
    let body: string[];
    if (isTemplate(template)) {
      const work = r.work as Parameters<typeof workLines>[1];
      const tgt = targetOf(template, work, r.division.targetPerShift);
      body = [
        summaryOf(template, work).map((s) => `${s.label}: ${s.value.toLocaleString("id-ID")}${s.unit ? ` ${s.unit}` : ""}`).join(" | "),
        ...(tgt ? [tgt.reached ? targetLine(tgt) : `<b>${targetLine(tgt)}</b>`] : []),
        "",
        ...workLines(template, work).map(esc),
        ...lpgLines(r.work, lpgRes).map(esc),
        ...sampleLines(r.work, sampleItems, sampleStoreNames).map(esc),
        ...(await boronganLines(template, r.date, r.divisionId)).map(esc),
        ...(await receiptReportLines(r.divisionId, r.date)).map((l) => (l.includes("⚠") ? `<b>${esc(l)}</b>` : esc(l))),
        ...rejectLines(r.work, itemNames).map(esc),
        ...boronganBalanceLines(balance).map(esc),
        ...(resultStatus ? resultLines(resultStatus).map((l) => (l.includes("⚠") ? `<b>${esc(l)}</b>` : esc(l))) : []),
        ...(receipts.length ? ["", `<b>Barang masuk (${receipts.length})</b>`, ...receipts.map((x) => `• ${esc(x.item.name)}: ${Number(x.qty).toLocaleString("id-ID")} ${esc(x.item.unit)}${x.supplierName ? ` · ${esc(x.supplierName)}` : ""}${x.purchaseId ? "" : " (belum dicatat di Pembelian)"}`)] : []),
        "",
        `<b>Checklist penutupan ${checklist.filter(isDone).length}/${checklist.length}</b>`,
        ...checklist.filter((c) => !isDone(c)).map((c) => `✗ ${esc(c.label)}${c.photo ? " (foto belum ada)" : ""}`),
      ];
    } else {
      const entries = await prisma.productionEntry.groupBy({ by: ["stage"], where: { date: r.date, shiftId: r.shiftId, divisionId: r.divisionId }, _sum: { qtyGood: true, qtyReject: true } });
      body = [
        ...entries.map((e) => `• ${STAGE_LABEL[e.stage]}: ${e._sum.qtyGood ?? 0} pcs (reject ${e._sum.qtyReject ?? 0})`),
        `Checklist ${checklist.filter(isDone).length}/${checklist.length}`,
      ];
    }
    const text = [
      `<b>Laporan Penutup Shift · ${esc(r.division.name)} · ${esc(r.shift.name)}</b>`,
      `${fmtDay(r.date)} | PIC: ${esc(r.picName ?? r.createdBy)}`,
      ...body,
      order.length ? `\n<b>⚠️ Order bahan baku</b>` : "",
      ...order.map((o) => `• ${esc(o.name)}: stok ${o.qty} ${esc(o.unit)} · limit ${o.limit} ${esc(o.unit)}`),
      r.complaints ? `\nCatatan/kendala: ${esc(r.complaints)}` : "",
      r.followUp ? `Tindak lanjut: ${esc(r.followUp)} [${r.followUpStatus}]` : "",
      `\nDikirim oleh ${esc(user.name)}`,
    ].filter((x) => x !== "").join("\n");
    // Kirim ke penerima laporan via Telegram bila dikonfigurasi; selalu tercatat di riwayat pengiriman
    let status = "TERKIRIM";
    let error: string | null = null;
    let channel = "SISTEM";
    if (telegramConfigured()) {
      channel = "TELEGRAM";
      const recipients = await prisma.telegramIdentity.findMany({ where: { active: true, receiveRecap: true, chatId: { not: null } } });
      const results = await Promise.all(recipients.map((x) => sendTelegram(x.chatId!, text, { type: "LAPORAN_SHIFT" })));
      const failed = results.filter((x) => !x.ok);
      if (recipients.length === 0) { status = "GAGAL"; error = "Belum ada penerima laporan di Telegram"; }
      else if (failed.length) { status = failed.length === results.length ? "GAGAL" : "SEBAGIAN"; error = failed.map((f) => f.error).join("; "); }
    }
    await prisma.$transaction([
      prisma.reportSend.create({ data: { reportId: id, sentBy: user.name, channel, status, error } }),
      prisma.shiftReport.update({ where: { id }, data: { status: status === "GAGAL" ? r.status : "TERKIRIM" } }),
    ]);
    await audit(user, "LAPORAN_DIKIRIM", "ShiftReport", id, { status, channel, stockAdjusted: stockRes.adjusted, stockSkipped: stockRes.skipped ?? null, workPosted: flowRes.posted, rejectRows: rejectRes.rows, rejectPosted: rejectRes.posted, sampleRows: sampleRes.rows, samplePosted: sampleRes.posted, resultAdjusted: resultRes.adjusted });
    // JPG laporan ke penerima & grup Telegram (latar belakang; tidak menahan tombol Kirim)
    if (channel === "TELEGRAM" && status !== "GAGAL") {
      const summary = isTemplate(template) ? summaryOf(template, r.work as Parameters<typeof workLines>[1]).map((s) => `${s.label}: ${s.value.toLocaleString("id-ID")}${s.unit ? ` ${s.unit}` : ""}`).join(" | ") : "";
      void sendShiftReportJpg(id, user.id, summary).catch((e) => console.error("JPG laporan shift gagal:", e));
    }
    if (status === "GAGAL") throw new Error(`Pengiriman gagal: ${error}${stockRes.adjusted ? " (stok akhir shift sudah tercatat)" : ""}`);
    const msg = status === "SEBAGIAN" ? "Terkirim sebagian, cek riwayat" : "Laporan terkirim";
    return stockRes.skipped ? `${msg}. ${stockRes.skipped}` : msg;
  }
}

/** Baris teks reject laporan untuk pesan Telegram */
function rejectLines(work: unknown, names: Map<string, string>): string[] {
  const list = storedRejects(work);
  if (!list.length) return [];
  return ["REJECT", ...list.map((x) => `• ${names.get(x.itemId) ?? "Barang"}: ${x.qty.toLocaleString("id-ID")} — ${REJECT_REASONS[x.reason] ?? x.reason}${x.note ? ` (${x.note})` : ""}`)];
}

/** Baris LPG untuk pesan Telegram */
function lpgLines(work: unknown, res: Awaited<ReturnType<typeof applyLpg>>): string[] {
  const l = storedLpgFor(work);
  if (!l) return [];
  return [`LPG tabung 5 kg: penuh ${l.penuh} · aktif ${l.aktif} · kosong ${l.kosong}${l.isiUlang ? ` · isi ulang diterima ${l.isiUlang}` : ""}${res && res.habis > 0 ? ` · tabung habis ${res.habis}` : ""}${res && res.total !== res.totalAset ? ` ⚠ total ${res.total} ≠ aset ${res.totalAset}` : ""}`];
}

/** Baris sample affiliator untuk pesan Telegram (bukan resi penjualan) */
function sampleLines(work: unknown, names: Map<string, string>, stores: Map<string, string>): string[] {
  const list = storedSamples(work);
  if (!list.length) return [];
  return [`SAMPLE AFFILIATOR (${list.reduce((a, x) => a + x.qty, 0)} pcs, tidak dihitung resi penjualan)`, ...list.map((x) => `• ${names.get(x.itemId) ?? "Produk"} × ${x.qty} — ${SAMPLE_PLATFORMS[x.platform] ?? x.platform} · ${stores.get(x.storeId) ?? "toko"}`)];
}

/** Barang masuk hari ini (dari supplier/toko), dicatat sebelum stok akhir; foto nota opsional */
export async function addReceipt(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    await guardEditable(id, user);
    const qty = num(str(fd, "qty"));
    if (qty == null || qty <= 0) throw new Error("Isi jumlah barang masuk");
    let photoPath: string | null = null;
    let photoMime: string | null = null;
    const file = fd.get("photo");
    if (file instanceof File && file.size > 0) {
      photoMime = file.type || "image/jpeg";
      photoPath = await saveProof(Buffer.from(await file.arrayBuffer()), photoMime);
    }
    const purchaseLineId = optStr(fd, "purchaseLineId");
    // Menautkan ke pesanan = validasi barang datang: khusus yang berwenang Terima barang (Supervisor/Kapten)
    // Pesanan yang sudah dibayar (bukan COD) boleh divalidasi anggota yang mencatat barang datang;
    // pesanan COD (bayar di tempat dari rekening) tetap khusus yang berwenang Terima barang
    if (purchaseLineId && !user.can("stock.receive")) {
      const line = await prisma.purchaseLine.findUnique({ where: { id: purchaseLineId }, include: { purchase: { select: { cod: true } } } });
      if (!line || line.purchase.cod) throw new ForbiddenError();
    }
    await addShiftReceipt(id, { itemId: str(fd, "itemId"), qty, supplierName: optStr(fd, "supplierName"), photoPath, photoMime, purchaseLineId, bankAccountId: optStr(fd, "bankAccountId") }, user);
    revalidatePath(`/laporan/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal menyimpan barang masuk" };
  }
}

/**
 * Banyak barang masuk sekaligus: isian "lines" = JSON [{ itemId, qty, purchaseLineId?, supplierName? }], satu foto nota
 * opsional untuk semua baris, "bankAccountId" untuk pesanan COD.
 */
export async function addReceipts(fd: FormData): Promise<{ ok: boolean; error?: string; count?: number }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    await guardEditable(id, user);
    let raw: unknown;
    try {
      raw = JSON.parse(str(fd, "lines") || "[]");
    } catch {
      throw new Error("Data barang tidak terbaca. Muat ulang halaman.");
    }
    const lines = (Array.isArray(raw) ? raw : []).map((l: { itemId?: unknown; qty?: unknown; purchaseLineId?: unknown; supplierName?: unknown }) => ({
      itemId: String(l.itemId ?? ""), qty: num(String(l.qty ?? "")), purchaseLineId: l.purchaseLineId ? String(l.purchaseLineId) : null, supplierName: l.supplierName ? String(l.supplierName) : null,
    }));
    if (!lines.length) throw new Error("Isi minimal satu barang");
    if (lines.some((l) => !l.itemId)) throw new Error("Pilih barang di setiap baris");
    if (lines.some((l) => l.qty == null || l.qty <= 0)) throw new Error("Isi jumlah di setiap baris");
    // Pesanan COD hanya boleh divalidasi yang berwenang Terima barang (lihat addReceipt)
    const orderIds = lines.map((l) => l.purchaseLineId).filter((x): x is string => !!x);
    if (orderIds.length && !user.can("stock.receive")) {
      const cod = await prisma.purchaseLine.count({ where: { id: { in: orderIds }, purchase: { cod: true } } });
      if (cod) throw new ForbiddenError();
    }
    let photoPath: string | null = null;
    let photoMime: string | null = null;
    const file = fd.get("photo");
    if (file instanceof File && file.size > 0) {
      photoMime = file.type || "image/jpeg";
      photoPath = await saveProof(Buffer.from(await file.arrayBuffer()), photoMime);
    }
    const bankAccountId = optStr(fd, "bankAccountId");
    await addShiftReceipts(id, lines.map((l) => ({ itemId: l.itemId, qty: l.qty!, supplierName: l.supplierName, photoPath, photoMime, purchaseLineId: l.purchaseLineId, bankAccountId })), user);
    revalidatePath(`/laporan/${id}`);
    return { ok: true, count: lines.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal menyimpan barang masuk" };
  }
}

export async function removeReceipt(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    await guardReport(id, user);
    const x = await prisma.shiftReceipt.findUniqueOrThrow({ where: { id: str(fd, "receiptId") } });
    if (x.reportId !== id) throw new ForbiddenError();
    await removeShiftReceipt(x.id, user);
    revalidatePath(`/laporan/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Gagal menghapus barang masuk" };
  }
}

/** Terima kiriman hasil borongan dari halaman laporan shift (kapten divisi pemilik barang, mis. pot cat giftbox) */
export const confirmReturnForReport = action(
  "report.create",
  async (fd, user) => {
    const r = await guardReport(str(fd, "reportId"), user);
    const { boronganScope, receiveHandover } = await import("@/lib/borongan");
    await receiveHandover(str(fd, "id"), user, await boronganScope(prisma, user), { divisionId: r.divisionId });
    return "Kiriman diterima, stok sudah masuk gudang";
  },
  ["/laporan", "/borongan", "/stok"],
);

/** Tindak lanjut kendala laporan shift (Supervisor/Finance/Owner) */
export const saveFollowUp = action(
  "report.view",
  async (fd, user) => {
    if (!canFollowUp(user)) throw new ForbiddenError();
    const id = str(fd, "id");
    await guardReport(id, user);
    const status = str(fd, "followUpStatus");
    if (!["BELUM", "PROSES", "SELESAI"].includes(status)) throw new Error("Status tidak valid");
    await prisma.shiftReport.update({ where: { id }, data: { followUp: optStr(fd, "followUp"), followUpStatus: status } });
    await audit(user, "LAPORAN_TINDAK_LANJUT", "ShiftReport", id, { status });
    return "Tindak lanjut tersimpan";
  },
  ["/laporan", "/"],
);

/** Supervisor/Owner/Admin: pindahkan laporan yang salah shift ke shift lain (atau tukar dengan laporan shift tujuan) */
export const moveReport = action("report.create", async (fd, user) => {
  if (reportDivision(user) !== null) throw new ForbiddenError();
  const id = str(fd, "id");
  const r = await moveReportShift(id, str(fd, "toShiftId"), str(fd, "reason"), user, fd.get("mode") === "tukar" ? "tukar" : "pindah");
  revalidatePath("/laporan");
  return r.swapped ? `Laporan ditukar: sekarang ${r.to}` : `Laporan dipindah dari ${r.from} ke ${r.to}`;
});
