import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { audit } from "./audit";
import { nextSequence } from "./contract";
import { dateOnly, dateStr } from "./time";

export class InvoiceError extends Error {}

type Actor = { id: string; name: string };

/** Toko yang menerbitkan invoice (kode master Store) dan channel penjualan */
export const INVOICE_STORES = ["MG", "DL"] as const;
export const CHANNELS = {
  TTS: { label: "TikTok Shop", priceChannel: "TIKTOK_SHOP" },
  SHP: { label: "Shopee", priceChannel: "SHOPEE" },
  OFF: { label: "Offline", priceChannel: "OFFLINE" },
} as const;
export type InvoiceChannel = keyof typeof CHANNELS;
export const isChannel = (c: string): c is InvoiceChannel => c in CHANNELS;

/** INV/{MG|DL}/{TTS|SHP|OFF}/{YYMM}/{urut 4 digit} */
export const invoiceNumber = (store: string, channel: string, yymm: string, seq: number) => `INV/${store}/${channel}/${yymm}/${String(seq).padStart(4, "0")}`;
export const yymmOf = (date: string) => date.slice(2, 4) + date.slice(5, 7);

export type InvoiceLine = { name: string; unit: string; qty: number; price: number; amount: number };
export type InvoiceLineInput = { itemId: string; qty: number; price: number };

/** Jumlah baris, total, dan kesalahan isian (murni, mudah dites) */
export function invoiceTotals(lines: { qty: number; price: number }[], discount = 0, shipping = 0) {
  if (!lines.length) throw new InvoiceError("Tambahkan minimal satu barang");
  for (const l of lines) {
    if (!(l.qty > 0)) throw new InvoiceError("Jumlah barang harus lebih dari 0");
    if (!Number.isInteger(l.price) || l.price < 0) throw new InvoiceError("Harga harus angka rupiah (tanpa desimal)");
  }
  if (discount < 0 || shipping < 0) throw new InvoiceError("Diskon dan ongkir tidak boleh negatif");
  const subtotal = lines.reduce((a, l) => a + Math.round(l.qty * l.price), 0);
  if (discount > subtotal) throw new InvoiceError("Diskon melebihi jumlah harga");
  return { subtotal, total: subtotal - discount + shipping };
}

export type InvoiceInput = {
  storeId: string;
  channel: string;
  date: string;
  customerName: string;
  lines: InvoiceLineInput[];
  discount?: number;
  shipping?: number;
  /** Sudah dibayar (Rp); marketplace biasanya lunas di muka */
  paid?: number;
  note?: string | null;
  saleId?: string | null;
};

/** Terbitkan invoice bernomor resmi; nomor dari pencacah atomik per toko+channel+bulan (tidak pernah dipakai ulang) */
export async function createInvoice(actor: Actor, input: InvoiceInput) {
  if (!isChannel(input.channel)) throw new InvoiceError("Pilih channel: TikTok Shop, Shopee, atau Offline");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new InvoiceError("Tanggal tidak valid");
  if (input.customerName.trim().length < 2) throw new InvoiceError("Nama pembeli wajib diisi");
  const store = await prisma.store.findUnique({ where: { id: input.storeId } });
  if (!store) throw new InvoiceError("Toko tidak ditemukan");
  if (!(INVOICE_STORES as readonly string[]).includes(store.code)) throw new InvoiceError(`Toko ${store.name} belum punya kode invoice (MG atau DL)`);
  const items = await prisma.item.findMany({ where: { id: { in: input.lines.map((l) => l.itemId) } }, select: { id: true, name: true, unit: true } });
  const lines: InvoiceLine[] = input.lines.map((l) => {
    const it = items.find((x) => x.id === l.itemId);
    if (!it) throw new InvoiceError("Barang tidak ditemukan");
    return { name: it.name, unit: it.unit, qty: l.qty, price: l.price, amount: Math.round(l.qty * l.price) };
  });
  const discount = input.discount ?? 0;
  const shipping = input.shipping ?? 0;
  const { subtotal, total } = invoiceTotals(lines, discount, shipping);
  const paid = Math.max(0, Math.min(total, input.paid ?? 0));
  const yymm = yymmOf(input.date);
  return prisma.$transaction(async (tx) => {
    if (input.saleId) {
      const ex = await tx.invoice.findUnique({ where: { saleId: input.saleId } });
      if (ex) return ex;
    }
    const seq = await nextSequence(tx, `INV:${store.code}:${input.channel}:${yymm}`);
    const number = invoiceNumber(store.code, input.channel, yymm, seq);
    const inv = await tx.invoice.create({
      data: {
        number, seq, storeCode: store.code, channel: input.channel, yymm, date: dateOnly(input.date), storeId: store.id, saleId: input.saleId ?? null,
        customerName: input.customerName.trim().slice(0, 120), lines: lines as unknown as Prisma.InputJsonValue,
        subtotal: BigInt(subtotal), discount: BigInt(discount), shipping: BigInt(shipping), total: BigInt(total), paid: BigInt(paid),
        note: input.note?.trim().slice(0, 300) || null, createdBy: actor.name,
      },
    });
    await audit(actor, "INVOICE_DITERBITKAN", "Invoice", inv.id, { number, total }, tx);
    return inv;
  });
}

/** Invoice dari penjualan offline: pembayaran mengikuti penjualan (lunas/piutang) */
export async function invoiceFromSale(actor: Actor, saleId: string) {
  const ex = await prisma.invoice.findUnique({ where: { saleId } });
  if (ex) return ex;
  const s = await prisma.sale.findUnique({ where: { id: saleId }, include: { lines: { include: { item: { select: { id: true } } } } } });
  if (!s) throw new InvoiceError("Penjualan tidak ditemukan");
  if (s.cancelledAt) throw new InvoiceError("Penjualan ini sudah dibatalkan");
  return createInvoice(actor, {
    storeId: s.storeId, channel: "OFF", date: dateStr(s.date), customerName: s.customerName,
    lines: s.lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), price: Number(l.price) })),
    discount: Number(s.discount), shipping: Number(s.shipping), paid: Number(s.paid), note: s.note, saleId,
  });
}

/** Status tampilan: lunas bila yang dibayar ≥ total (invoice dari penjualan memakai pembayaran penjualan saat ini) */
export function invoiceStatus(inv: { total: bigint; paid: bigint; cancelledAt: Date | null }, salePaid?: bigint | null) {
  if (inv.cancelledAt) return { key: "BATAL", label: "Dibatalkan", lunas: false } as const;
  const paid = salePaid ?? inv.paid;
  return paid >= inv.total ? ({ key: "LUNAS", label: "Lunas", lunas: true } as const) : ({ key: "BELUM", label: "Belum lunas", lunas: false } as const);
}

/** Batalkan invoice (nomor tetap tercatat, tidak dipakai ulang) */
export async function voidInvoice(actor: Actor, id: string, reason: string) {
  if (reason.trim().length < 3) throw new InvoiceError("Tulis alasan pembatalan");
  const r = await prisma.invoice.updateMany({ where: { id, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: reason.trim().slice(0, 300) } });
  if (!r.count) throw new InvoiceError("Invoice sudah dibatalkan atau tidak ditemukan");
  await audit(actor, "INVOICE_DIBATALKAN", "Invoice", id, { alasan: reason.trim() });
}

/** Harga terakhir per barang jadi untuk tiap channel (dari Produk & HPP) */
export async function channelPrices(): Promise<Record<string, Partial<Record<InvoiceChannel, number>>>> {
  const products = await prisma.product.findMany({
    where: { finishedItemId: { not: null } },
    select: { finishedItemId: true, prices: { orderBy: { effectiveAt: "desc" }, select: { channel: true, price: true } } },
  });
  const out: Record<string, Partial<Record<InvoiceChannel, number>>> = {};
  for (const p of products) {
    const m: Partial<Record<InvoiceChannel, number>> = {};
    for (const [code, c] of Object.entries(CHANNELS) as [InvoiceChannel, (typeof CHANNELS)[InvoiceChannel]][]) {
      const hit = p.prices.find((x) => x.channel === c.priceChannel);
      if (hit) m[code] = Number(hit.price);
    }
    out[p.finishedItemId!] = m;
  }
  return out;
}

