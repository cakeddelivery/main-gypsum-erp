"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { action, str, optStr } from "@/lib/action";
import { audit } from "@/lib/audit";
import { dateOnly, fmtDay } from "@/lib/time";
import { assertPerm, ForbiddenError } from "@/lib/auth";
import { sendTelegram, telegramConfigured, esc } from "@/lib/telegram";
import { STAGE_LABEL, itemTotals, locationSettings, recordMovement } from "@/lib/stock";
import { saveProof } from "@/lib/storage";
import { isDone, isTemplate, needsOrder, parseWork, summaryOf, toEntries, workLines, type ChecklistEntry, type StockCountRow } from "@/lib/shiftReport";

const DEFAULT_CHECKLIST = ["Area kerja bersih & rapi", "Peralatan/cetakan dicek", "Bahan cukup untuk shift berikutnya", "Hasil sudah dihitung ulang", "Reject dipisahkan & dicatat"];

type User = Awaited<ReturnType<typeof assertPerm>>;

/** Kapten & operator hanya boleh melaporkan divisinya sendiri */
function ownDivisionOnly(user: User) {
  return user.role === "KAPTEN_DIVISI" || user.role === "OPERATOR";
}

function guardDivision(user: User, divisionId: string) {
  if (ownDivisionOnly(user) && user.divisionId !== divisionId) throw new ForbiddenError();
}

/** Daftar bahan baku divisi untuk stok akhir shift; hitungan lama dipertahankan */
async function stockRows(divisionId: string, prev: StockCountRow[] = []): Promise<StockCountRow[]> {
  const items = await prisma.item.findMany({ where: { divisionId, active: true, type: "BAHAN_BAKU" }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return items.map((i) => ({ itemId: i.id, name: i.name, unit: i.unit, limit: Number(i.minStock), qty: prev.find((p) => p.itemId === i.id)?.qty ?? null }));
}

export async function openReport(fd: FormData) {
  const user = await assertPerm("report.create");
  const date = str(fd, "date");
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
      picName: user.employee?.name ?? user.name,
      checklist,
      stockCount: await stockRows(divisionId),
    },
    update: {},
  });
  redirect(`/laporan/${r.id}`);
}

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

export const saveReport = action(
  "report.create",
  async (fd, user) => {
    const id = str(fd, "id");
    const r = await guardReport(id, user);
    const checklist = toEntries(r.checklist).map((c, i) => ({ ...c, done: c.photo ? !!c.photoPath : fd.get(`check_${i}`) === "on" }));
    const template = r.division.reportTemplate;
    const work = isTemplate(template) ? parseWork(template, (k) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : null)) : {};
    const stock = (await stockRows(r.divisionId, r.stockCount as StockCountRow[])).map((row) => (fd.has(`s.${row.itemId}`) ? { ...row, qty: num(str(fd, `s.${row.itemId}`)) } : row));
    await prisma.shiftReport.update({
      where: { id },
      data: {
        checklist,
        work: work as Prisma.InputJsonValue,
        stockCount: stock,
        picName: optStr(fd, "picName"),
        complaints: optStr(fd, "complaints"),
        followUp: optStr(fd, "followUp"),
        followUpStatus: str(fd, "followUpStatus") || "BELUM",
        status: r.status === "TERKIRIM" ? "DIREVISI" : r.status,
      },
    });
    await audit(user, "LAPORAN_DIUBAH", "ShiftReport", id);
    return "Laporan tersimpan";
  },
  ["/laporan"],
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

/**
 * Stock opname dari laporan: stok sistem tiap bahan disesuaikan ke hasil hitung fisik
 * (selisih dicatat sebagai mutasi PENYESUAIAN di lokasi bahan baku).
 * Laporan yang direvisi & dikirim ulang hanya menerapkan selisih hitungan baru vs hitungan yang dulu diterapkan,
 * agar mutasi stok setelah laporan pertama (mis. pembelian) tidak tertimpa hitungan lama.
 */
async function applyStockCount(report: { id: string; stockApplied: boolean; stockAppliedCount: Prisma.JsonValue | null }, rows: StockCountRow[], user: User, date: Date) {
  const { raw } = await locationSettings(prisma);
  if (!raw) return 0;
  const prev = report.stockApplied ? (report.stockAppliedCount as StockCountRow[] | null) : null;
  // Laporan lama yang sudah diterapkan tanpa catatan hitungan: jangan timpa stok terkini
  if (report.stockApplied && !prev) return 0;
  let n = 0;
  await prisma.$transaction(async (tx) => {
    const totals = await itemTotals(tx);
    const applied = new Map((prev ?? []).map((p) => [p.itemId, p.qty]));
    for (const row of rows) {
      if (row.qty == null) continue;
      const before = applied.get(row.itemId);
      const diff = Math.round((before != null ? row.qty - before : row.qty - (totals.get(row.itemId) ?? 0)) * 1000) / 1000;
      if (diff === 0) continue;
      await recordMovement(tx, { type: "PENYESUAIAN", itemId: row.itemId, qty: Math.abs(diff), fromLocationId: raw, increase: diff > 0, allowNegative: true, ref: `LAP:${report.id}`, note: before != null ? "Revisi stock opname laporan shift" : "Stock opname laporan shift", date }, user);
      n++;
    }
    const snapshot = [...(prev ?? []).filter((p) => !rows.some((r) => r.itemId === p.itemId && r.qty != null)), ...rows.filter((r) => r.qty != null)];
    await tx.shiftReport.update({ where: { id: report.id }, data: { stockApplied: true, stockAppliedCount: snapshot as unknown as Prisma.InputJsonValue } });
  }, { timeout: 30000 });
  return n;
}

export const sendReport = action(
  "report.create",
  async (fd, user) => {
    const id = str(fd, "id");
    await guardReport(id, user);
    const r = await prisma.shiftReport.findUniqueOrThrow({ where: { id }, include: { shift: true, division: true } });
    const template = r.division.reportTemplate;
    const checklist = toEntries(r.checklist) as ChecklistEntry[];
    const stock = r.stockCount as StockCountRow[];
    const order = stock.filter(needsOrder);
    let body: string[];
    if (isTemplate(template)) {
      const work = r.work as Parameters<typeof workLines>[1];
      body = [
        summaryOf(template, work).map((s) => `${s.label}: ${s.value.toLocaleString("id-ID")}${s.unit ? ` ${s.unit}` : ""}`).join(" | "),
        "",
        ...workLines(template, work).map(esc),
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
    // Stok akhir shift = stock opname bahan baku divisi
    const adjusted = await applyStockCount(r, stock, user, new Date());
    await audit(user, "LAPORAN_DIKIRIM", "ShiftReport", id, { status, channel, stockAdjusted: adjusted });
    if (status === "GAGAL") throw new Error(`Pengiriman gagal: ${error}`);
    return status === "SEBAGIAN" ? "Terkirim sebagian, cek riwayat" : "Laporan terkirim";
  },
  ["/laporan", "/", "/stok"],
);
