"use server";
import { revalidatePath } from "next/cache";
import { action, str } from "@/lib/action";
import { assertPerm } from "@/lib/auth";
import { friendly } from "@/lib/action";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { createInvoice, InvoiceError } from "@/lib/invoice";
import { commitImport, previewImport, undoImport, MarketplaceImportError, type ImportFile, type Preview } from "@/lib/marketplace/import";
import { FormatError, parseMarketplaceFile } from "@/lib/marketplace/parse";
import { resolveSkuKeys } from "@/lib/marketplace/sku";
import { dateStr } from "@/lib/time";

const MAX_FILES = 4;
const MAX_BYTES = 12 * 1024 * 1024;

type SerPreview = { files: (Omit<Preview["files"][number], "periodFrom" | "periodTo"> & { periodFrom: string | null; periodTo: string | null })[]; totals: Preview["totals"] };
export type PreviewResult = { ok: boolean; error?: string; fileErrors?: { fileName: string; error: string }[]; preview?: SerPreview; message?: string };

async function readFiles(fd: FormData): Promise<{ files: ImportFile[]; fileErrors: { fileName: string; error: string }[] }> {
  const raw = fd.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const stores = fd.getAll("storeId").map(String);
  if (!raw.length) throw new MarketplaceImportError("Pilih minimal satu file Excel (.xlsx)");
  if (raw.length > MAX_FILES) throw new MarketplaceImportError(`Maksimal ${MAX_FILES} file sekaligus`);
  const files: ImportFile[] = [];
  const fileErrors: { fileName: string; error: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (f.size > MAX_BYTES) {
      fileErrors.push({ fileName: f.name, error: "File terlalu besar (maks 12 MB). Unduh per bulan dari Seller Center." });
      continue;
    }
    if (!stores[i]) {
      fileErrors.push({ fileName: f.name, error: "Pilih toko untuk file ini" });
      continue;
    }
    try {
      files.push({ fileName: f.name, storeId: stores[i], parsed: await parseMarketplaceFile(Buffer.from(await f.arrayBuffer())) });
    } catch (e) {
      fileErrors.push({ fileName: f.name, error: e instanceof FormatError ? e.message : "File tidak bisa dibaca. Pastikan ini file Excel asli dari Seller Center." });
    }
  }
  return { files, fileErrors };
}

const ser = (p: Preview): SerPreview => ({ totals: p.totals, files: p.files.map((f) => ({ ...f, periodFrom: f.periodFrom ? dateStr(f.periodFrom) : null, periodTo: f.periodTo ? dateStr(f.periodTo) : null })) });

/** Tahap 1: baca & tampilkan pratinjau. TIDAK menulis apa pun ke database. */
export async function previewMarketplaceAction(fd: FormData): Promise<PreviewResult> {
  try {
    await assertPerm("sales.manage");
    const { files, fileErrors } = await readFiles(fd);
    if (!files.length) return { ok: false, error: fileErrors[0]?.error ?? "Tidak ada file yang bisa dibaca", fileErrors };
    return { ok: true, fileErrors, preview: ser(await previewImport(files)) };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
}

/** Tahap 2: simpan (satu batch per file). File dibaca ulang di server, jadi pratinjau tidak bisa dipalsukan. */
export async function saveMarketplaceAction(fd: FormData): Promise<PreviewResult> {
  try {
    const user = await assertPerm("sales.manage");
    const { files, fileErrors } = await readFiles(fd);
    if (fileErrors.length || !files.length) return { ok: false, error: fileErrors[0]?.error ?? "Tidak ada file yang bisa disimpan", fileErrors };
    const res = await commitImport(user, files);
    revalidatePath("/penjualan", "layout");
    const baru = res.reduce((a, r) => a + r.baru, 0), upd = res.reduce((a, r) => a + r.diperbarui, 0), skip = res.reduce((a, r) => a + r.dilewati, 0);
    return { ok: true, message: `Impor tersimpan: ${baru} baru, ${upd} diperbarui, ${skip} dilewati (sama persis)` };
  } catch (e) {
    return { ok: false, error: e instanceof MarketplaceImportError ? e.message : friendly(e) };
  }
}

export const undoImportAction = action(
  "sales.manage",
  async (fd, user) => {
    await undoImport(user, str(fd, "id"));
    return "Batch impor dibatalkan";
  },
  ["/penjualan"],
);

/** Petakan SKU marketplace: ke produk ERP, atau tandai sebagai Extra Packing (bukan produk jadi) */
export const mapSkuAction = action(
  "sales.manage",
  async (fd, user) => {
    const key = str(fd, "key");
    if (!key.includes("|")) throw new InvoiceError("Kunci SKU tidak valid");
    const kind = str(fd, "kind");
    if (kind === "EXTRA_PACKING") {
      const variant = str(fd, "variant").slice(0, 60) || null;
      await prisma.marketplaceSkuClass.upsert({ where: { key }, create: { key, kind, variant, updatedBy: user.name }, update: { kind, variant, updatedBy: user.name } });
      await prisma.marketplaceSkuMap.deleteMany({ where: { key } });
      await audit(user, "MARKETPLACE_SKU_EXTRA", "MarketplaceSkuClass", key, { variant });
      return "Ditandai sebagai Extra Packing";
    }
    const itemId = str(fd, "itemId");
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { type: true } });
    if (!item || item.type !== "BARANG_JADI") throw new InvoiceError("Pilih produk jadi ERP");
    await prisma.marketplaceSkuClass.deleteMany({ where: { key } });
    await prisma.marketplaceSkuMap.upsert({ where: { key }, create: { key, itemId, updatedBy: user.name }, update: { itemId, updatedBy: user.name } });
    await audit(user, "MARKETPLACE_SKU_PETA", "MarketplaceSkuMap", key, { itemId });
    return "Pemetaan tersimpan";
  },
  ["/penjualan", "/retur"],
);

export const toggleComplaintAction = action(
  "sales.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const o = await prisma.marketplaceOrder.findUniqueOrThrow({ where: { id }, select: { complaint: true } });
    const next = !o.complaint;
    await prisma.marketplaceOrder.update({ where: { id }, data: { complaint: next, complaintNote: next ? str(fd, "note").slice(0, 200) || null : null } });
    await audit(user, next ? "MARKETPLACE_KOMPLAIN" : "MARKETPLACE_KOMPLAIN_CABUT", "MarketplaceOrder", id);
    return next ? "Ditandai komplain" : "Tanda komplain dicabut";
  },
  ["/penjualan"],
);

/** Terbitkan invoice resmi dari pesanan (nomor INV/{toko}/{kanal}/{YYMM}/{urut}); hanya satu per pesanan */
export const invoiceFromOrderAction = action(
  "sales.manage",
  async (fd, user) => {
    const id = str(fd, "id");
    const o = await prisma.marketplaceOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
    if (o.invoiceId) throw new InvoiceError("Pesanan ini sudah punya invoice");
    if (o.status === "BATAL") throw new InvoiceError("Pesanan batal tidak diinvoice");
    const res = await resolveSkuKeys(o.lines.map((l) => l.skuKey));
    const lines: { itemId: string; qty: number; price: number }[] = [];
    let extra = 0;
    for (const l of o.lines) {
      const r = res.get(l.skuKey);
      if (!r) throw new InvoiceError(`SKU ${l.sku ?? "-"} belum dipetakan ke produk. Petakan dulu di Pemetaan SKU.`);
      if (r.kind === "EXTRA_PACKING") extra += Number(l.amount);
      else lines.push({ itemId: r.itemId, qty: l.qty, price: Number(l.unitPrice) });
    }
    if (!lines.length) throw new InvoiceError("Pesanan ini hanya berisi Extra Packing; tidak ada produk untuk diinvoice");
    const inv = await createInvoice(user, {
      storeId: o.storeId, channel: o.channel, date: dateStr(o.orderedAt ?? new Date()), customerName: `Pembeli ${o.channel === "SHP" ? "Shopee" : "TikTok"} ${o.orderNo}`, lines,
      shipping: Number(o.shippingPaid), paid: Number.MAX_SAFE_INTEGER, note: `Pesanan marketplace ${o.orderNo}${extra ? ` · Extra Packing Rp ${extra.toLocaleString("id-ID")} tidak dimasukkan` : ""}`,
    });
    await prisma.marketplaceOrder.update({ where: { id }, data: { invoiceId: inv.id } });
    return `Invoice ${inv.number} terbit`;
  },
  ["/penjualan"],
);
