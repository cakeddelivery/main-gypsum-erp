import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { addDays, fmtDate, jakartaDateTime, jakartaParts, todayStr } from "@/lib/time";
import { locationSettings, stockBalances } from "@/lib/stock";
import { offlinePrices, saleStatus } from "@/lib/sales";
import { defaultStoreId } from "@/lib/accounting";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { Paged } from "@/components/Paged";
import { DownloadCsv } from "@/components/DownloadCsv";
import { SaleFields } from "./SaleForm";
import { saveSale } from "./actions";

export const metadata = { title: "Penjualan" };

type SP = { from?: string; to?: string; q?: string; status?: string; customer?: string };
const STATUS = [
  { key: "", label: "Semua" },
  { key: "PIUTANG", label: "Belum lunas" },
  { key: "LUNAS", label: "Lunas" },
  { key: "BATAL", label: "Dibatalkan" },
];

export default async function PenjualanPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("sales.view");
  const sp = await searchParams;
  const p = jakartaParts();
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : `${p.year}-${String(p.month).padStart(2, "0")}-01`;
  const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : todayStr();
  const q = sp.q?.trim();
  const where: Prisma.SaleWhereInput = {
    date: { gte: jakartaDateTime(from, "00:00"), lt: jakartaDateTime(addDays(to, 1), "00:00") },
    ...(sp.customer ? { customerId: sp.customer } : {}),
    ...(q ? { OR: [{ number: { contains: q, mode: "insensitive" } }, { customerName: { contains: q, mode: "insensitive" } }, { note: { contains: q, mode: "insensitive" } }] } : {}),
    ...(sp.status === "BATAL" ? { cancelledAt: { not: null } } : sp.status ? { cancelledAt: null } : {}),
  };
  const canManage = user.can("sales.manage");
  const [rows, open, items, customers, banks, stores, defStore, prices, locs] = await Promise.all([
    prisma.sale.findMany({ where, include: { lines: { include: { item: true } } }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 500 }),
    prisma.sale.findMany({ where: { cancelledAt: null }, select: { total: true, paid: true, dueDate: true } }),
    canManage ? prisma.item.findMany({ where: { active: true, type: "BARANG_JADI" }, orderBy: { name: "asc" } }) : [],
    canManage ? prisma.customer.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [],
    canManage ? prisma.bankAccount.findMany({ where: { active: true, marketplace: false }, orderBy: { code: "asc" } }) : [],
    prisma.store.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
    defaultStoreId(),
    canManage ? offlinePrices() : new Map<string, number>(),
    locationSettings(prisma),
  ]);
  const list = rows.filter((s) => (sp.status === "LUNAS" ? s.total <= s.paid : sp.status === "PIUTANG" ? s.total > s.paid : true));
  const stock = canManage ? await stockBalances(prisma) : [];
  const stockOf = (itemId: string) => stock.find((b) => b.itemId === itemId && b.locationId === locs.finished)?.qty ?? 0;
  const active = list.filter((s) => !s.cancelledAt);
  const omzet = active.reduce((t, s) => t + Number(s.total), 0);
  const hpp = active.reduce((t, s) => t + Number(s.hpp), 0);
  const piutang = open.reduce((t, s) => t + Math.max(0, Number(s.total - s.paid)), 0);
  const overdue = open.filter((s) => s.total > s.paid && s.dueDate && s.dueDate < new Date()).length;
  const customerName = sp.customer ? (await prisma.customer.findUnique({ where: { id: sp.customer } }))?.name : null;
  const qs = (patch: Partial<SP>) => `/penjualan?${new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][]).toString()}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Penjualan"
        subtitle="Penjualan offline (pelanggan langsung / WhatsApp). Pendapatan, stok barang jadi, HPP, dan piutang tercatat sekaligus."
        actions={<>
          <DownloadCsv filename={`penjualan-${from}-${to}`} rows={[["No.", "Tanggal", "Toko", "Pelanggan", "Barang", "Subtotal", "Diskon", "Ongkir", "Tagihan", "Dibayar", "Sisa", "HPP", "Status"], ...list.map((s) => [s.number, fmtDate(s.date), stores.find((x) => x.id === s.storeId)?.code ?? "", s.customerName, s.lines.map((l) => `${l.item.name} × ${Number(l.qty)}`).join("; "), Number(s.subtotal), Number(s.discount), Number(s.shipping), Number(s.total), Number(s.paid), Number(s.total - s.paid), Number(s.hpp), saleStatus(s).label])]} />
          {canManage && (
            <Modal trigger="+ Penjualan" title="Penjualan baru" wide>
              <ModalForm action={saveSale}>
                <SaleFields
                  items={items.map((i) => ({ id: i.id, name: i.name, unit: i.unit, stock: stockOf(i.id), price: prices.get(i.id) ?? 0 }))}
                  customers={customers} banks={banks} stores={stores} today={todayStr()} defaultStore={defStore}
                  defaultBank={banks.find((b) => b.code === "SEABANK")?.id}
                />
                <div className="mt-4"><Submit>Simpan penjualan</Submit></div>
              </ModalForm>
            </Modal>
          )}
        </>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Penjualan (periode)" value={idr(omzet)} hint={`${active.length} nota`} tone="green" />
        <Stat label="HPP (periode)" value={idr(hpp)} hint={`Laba kotor ${idr(omzet - hpp)}`} />
        <Stat label="Piutang pelanggan" value={idr(piutang)} hint="semua periode" tone="amber" href="/penjualan?status=PIUTANG&from=2000-01-01" />
        <Stat label="Lewat jatuh tempo" value={`${overdue} nota`} tone={overdue ? "red" : "slate"} href="/penjualan?status=PIUTANG&from=2000-01-01" />
      </div>
      <FilterBar>
        <Field label="Dari"><input type="date" name="from" defaultValue={from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="to" defaultValue={to} className="input" /></Field>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="input">{STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
        <Field label="Cari"><input name="q" defaultValue={q} className="input" placeholder="No. nota / pelanggan" /></Field>
        {sp.customer && <input type="hidden" name="customer" value={sp.customer} />}
      </FilterBar>
      {customerName && <p className="text-sm">Riwayat pelanggan <b>{customerName}</b> · <Link href={qs({ customer: undefined })} className="text-brand-600 underline">tampilkan semua</Link></p>}
      {list.length === 0 ? <Empty title="Belum ada penjualan" hint="Ubah filter tanggal atau catat penjualan baru." /> : (
        <Card title="Daftar penjualan">
          <div className="table-wrap">
            <Paged><table className="tbl">
              <thead><tr><th>No.</th><th>Tanggal</th><th>Pelanggan</th><th>Barang</th><th className="num">Tagihan</th><th className="num">Sisa</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.map((s) => {
                  const st = saleStatus(s);
                  const rest = Number(s.total - s.paid);
                  return (
                    <tr key={s.id}>
                      <td className="font-mono text-xs">{s.number}</td>
                      <td>{fmtDate(s.date)}</td>
                      <td>{s.customerId ? <Link href={qs({ customer: s.customerId })} className="hover:underline">{s.customerName}</Link> : s.customerName}</td>
                      <td className="text-xs">{s.lines.map((l) => `${l.item.name} × ${Number(l.qty).toLocaleString("id-ID")}`).join(", ")}</td>
                      <td className="num">{idr(s.total)}</td>
                      <td className="num">{!s.cancelledAt && rest > 0 ? idr(rest) : "-"}</td>
                      <td><Badge tone={st.tone}>{st.label}</Badge>{!s.cancelledAt && rest > 0 && s.dueDate && <div className="text-xs text-slate-500">tempo {fmtDate(s.dueDate)}</div>}</td>
                      <td><Link href={`/penjualan/${s.id}`} className="btn-secondary btn-sm">Detail</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></Paged>
          </div>
        </Card>
      )}
    </div>
  );
}
