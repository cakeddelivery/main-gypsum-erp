import { prisma } from "../db";
import { InvoiceError } from "../invoice";

/** Penanda sementara "invoice sedang diterbitkan" di MarketplaceOrder.invoiceId (tanpa FK) */
export const INVOICE_PENDING = "PENDING";

/**
 * Klaim atomik sebelum menerbitkan invoice dari pesanan: hanya SATU pemanggil (klik ganda / dua tab) yang lolos;
 * yang lain ditolak. Tanpa ini cek `invoiceId` lalu `createInvoice` bisa menerbitkan dua invoice untuk satu pesanan.
 */
export async function claimOrderInvoice(orderId: string) {
  const r = await prisma.marketplaceOrder.updateMany({ where: { id: orderId, invoiceId: null }, data: { invoiceId: INVOICE_PENDING } });
  if (r.count === 0) throw new InvoiceError("Pesanan ini sudah punya invoice atau invoicenya sedang diterbitkan");
}

/** Lepas klaim bila penerbitan gagal agar bisa dicoba lagi */
export async function releaseOrderInvoice(orderId: string) {
  await prisma.marketplaceOrder.updateMany({ where: { id: orderId, invoiceId: INVOICE_PENDING }, data: { invoiceId: null } });
}
