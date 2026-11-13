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
import { canSeeDivision } from "@/lib/reportScope";
import { sendTelegram, telegramConfigured, esc } from "@/lib/telegram";
import { STAGE_LABEL } from "@/lib/stock";
import { applyShiftStockCount } from "@/lib/shiftReportStock";
import { postShiftWork } from "@/lib/shiftReportFlow";
import { sendShiftReportJpg } from "@/lib/shiftReportJpg";
import { boronganLines } from "@/lib/shiftReportBorongan";
import { saveProof } from "@/lib/storage";
import { addShiftReceipt, removeShiftReceipt } from "@/lib/shiftReceipt";
import { RESULT_KEY, applyResultCount, parseResultCount, resultCountStatus, resultLines } from "@/lib/shiftResultCount";
import { reportCatalogs } from "@/lib/productFamily";
import { isDone, isTemplate, needsOrder, parseWork, summaryOf, targetLine, targetOf, toEntries, workLines, type ChecklistEntry, type StockCountRow } from "@/lib/shiftReport";

const DEFAULT_CHECKLIST = ["Area kerja bersih & rapi", "Peralatan/cetakan dicek", "Bahan cukup untuk shift berikutnya", "Hasil sudah dihitung ulang", "Reject dipisahkan & dicatat"];

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
  const date = str(fd, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Tanggal tidak valid");
  const shiftId = str(fd, "shiftId");
  const divisionId = str(fd, "divisionId");
  guardDivision(user, divisionId);
  const division = await prisma.division.findUniqueOrThrow({ where: { id: divisionId } });
  const allowed = (await prisma.shift.findMany({ where: { active: true }, orderBy: { code: "asc" }, take: Math.max(1, division.shiftCount) })).map((s) => s.id);
  if (!allowed.includes(shiftId)) throw new Error(`${division.name} hanya punya ${division.shiftCount} shift`);
  let checklist = toEntries(division.checklist);
  if (!checklist.length) {
    const setting = await prisma.setting.findUnique({ where: { key: "report_checklist" } });
    checklist = toEntries(setting ? setting.value.split("\n").map((s) => s.trim()).filter(Boolean) : DEFAULT_CHECKLIST);
  }
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
  // go=masuk: langsung buka popup Barang masuk; selain itu buka form isian laporan
  redirect(`/laporan/${r.id}?${fd.get("go") === "masuk" ? "masuk" : "isi"}=1`);
});

async function guardReport(id: string, user: User) {
  const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id }, include: { division: true } });
  guardDivision(user, r.divisionId);
  return r;
}

const num = (s: string) => {
  const t = s.replace(/\./g, "").replace(/,/g, ".");
  if (!t) return null;
  const x = Number(t);
  if (!Number.isFinite(x) || x < 0) throw new Error("Jumlah stok tidak valid");
  return x;
};

/** Simpan isian laporan (draf). Dipakai tombol "Simpan draf" dan sebelum "Kirim laporan" */
async function saveReportData(fd: FormData, user: User) {
  {
    const id = str(fd, "id");
    const r = await guardReport(id, user);
    const checklist = toEntries(r.checklist).map((c, i) => ({ ...c, done: c.photo ? !!c.photoPath : fd.get(`check_${i}`) === "on" }));
    const template = r.division.reportTemplate;
    const get = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : null);
    const work: Record<string, unknown> = isTemplate(template) ? parseWork(template, get, await reportCatalogs(template)) : {};
    const rc = parseResultCount(isTemplate(template) ? template : null, get);
    if (rc) work[RESULT_KEY] = rc;
    const stock = (await stockRows(r.divisionId, r.stockCount as StockCountRow[])).map((row) => (fd.has(`s.${row.itemId}`) ? { ...row, qty: num(str(fd, `s.${row.itemId}`)) } : row));
    await prisma.shiftReport.update({
      where: { id },
      data: {
        checklist,
        work: work as Prisma.InputJsonValue,
        stockCount: stock,
        picName: user.username,
        complaints: optStr(fd, "complaints"),
        followUp: optStr(fd, "followUp"),
        followUpStatus: str(fd, "followUpStatus") || "BELUM",
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
    await guardReport(id, user);
    const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id }, include: { shift: true, division: true } });
    // Stok akhir shift = stock opname bahan baku divisi (per jam selesai shift). Diterapkan dulu: bila gagal
    // (mis. periode sudah ditutup), laporan tidak dikirim agar pesan dan stok tidak berbeda.
    const stockRes = await applyShiftStockCount(id, user);
    // Bahan dengan stok ≤ limit → permintaan stok otomatis (tidak dobel bila masih ada yang terbuka)
    await autoRequestsFromReport(id, user).catch((e) => console.error("Permintaan stok otomatis gagal:", e));
    // Hasil kerja → stok setengah jadi / barang jadi (bila diaktifkan Owner)
    const flowRes = await postShiftWork(id, user);
    // Stok akhir hasil (patung kering / produk jadi per karakter): selisih ditandai; disamakan bila sakelar menyala
    const resultRes = await applyResultCount(id, user);
    const resultStatus = await resultCountStatus(id);
    const receipts = await prisma.shiftReceipt.findMany({ where: { reportId: id }, include: { item: true }, orderBy: { number: "asc" } });
    const template = r.division.reportTemplate;
    const checklist = toEntries(r.checklist) as ChecklistEntry[];
    const stock = r.stockCount as StockCountRow[];
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
        ...(await boronganLines(template, r.date)).map(esc),
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
    await audit(user, "LAPORAN_DIKIRIM", "ShiftReport", id, { status, channel, stockAdjusted: stockRes.adjusted, stockSkipped: stockRes.skipped ?? null, workPosted: flowRes.posted, resultAdjusted: resultRes.adjusted });
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

/** Barang masuk hari ini (dari supplier/toko), dicatat sebelum stok akhir; foto nota opsional */
export async function addReceipt(fd: FormData): Promise<{ ok: boolean; error?: string }> {
  try {
    const user = await assertPerm("report.create");
    const id = str(fd, "id");
    await guardReport(id, user);
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
    if (purchaseLineId && !user.can("stock.receive")) throw new ForbiddenError();
    await addShiftReceipt(id, { itemId: str(fd, "itemId"), qty, supplierName: optStr(fd, "supplierName"), photoPath, photoMime, purchaseLineId, bankAccountId: optStr(fd, "bankAccountId") }, user);
    revalidatePath(`/laporan/${id}`);
    return { ok: true };
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
