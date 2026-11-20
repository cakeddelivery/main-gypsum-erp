import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr, n } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { CHANNEL_LABEL, shownStatus, STATUS_LABEL, type ShownStatus } from "@/lib/marketplace/rules";
import { listOrders, orderSummary, type Tab } from "@/lib/marketplace/report";
import { Badge, Empty, Field, FilterBar, PageHeader, Stat, Tabs } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { MpNav } from "./MpNav";

export const metadata = { title: "Pesanan Marketplace" };
type SP = { toko?: string; kanal?: string; dari?: string; sampai?: string; tab?: string; q?: string };
const TONE: Record<ShownStatus, "amber" | "green" | "gray" | "red"> = { PIUTANG: "amber", CAIR: "green", BATAL: "gray", RETUR: "red" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePerm("sales.view");
  const sp = await searchParams;
  const tab = (["ALL", "PIUTANG", "CAIR", "BATAL", "RETUR"].includes(sp.tab ?? "") ? sp.tab : "ALL") as Tab;
  const f = { storeId: sp.toko || undefined, channel: sp.kanal === "SHP" || sp.kanal === "TTS" ? sp.kanal : undefined, from: DATE.test(sp.dari ?? "") ? sp.dari : undefined, to: DATE.test(sp.sampai ?? "") ? sp.sampai : undefined, q: sp.q };
  const [stores, sum, rows, noData] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    orderSummary(f),
    listOrders({ ...f, tab }, 300),
    prisma.marketplaceOrder.count({ take: 1 }).then((c) => c === 0),
  ]);
  const qs = (t: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ toko: sp.toko, kanal: sp.kanal, dari: sp.dari, sampai: sp.sampai, q: sp.q, tab: t })) if (v && !(k === "tab" && t === "ALL")) p.set(k, v);
    return `/penjualan/marketplace${p.size ? `?${p}` : ""}`;
  };
  const tabs = (["ALL", "PIUTANG", "CAIR", "BATAL", "RETUR"] as Tab[]).map((t) => ({ key: t, label: { ALL: "Semua", PIUTANG: "Piutang", CAIR: "Cair", BATAL: "Batal", RETUR: "Retur/Komplain" }[t], href: qs(t), count: sum.counts[t] }));
  return (
    <div className="space-y-4">
      <PageHeader title="Pesanan Marketplace" subtitle="Shopee & TikTok Shop dari file Excel · tidak mengubah stok maupun jurnal" actions={<Link href="/penjualan" className="btn-secondary">Penjualan</Link>} />
      <MpNav current="pesanan" />
      {noData ? (
        <Empty title="Belum ada pesanan marketplace" hint="Unggah file Order & Penghasilan dari Seller Center di menu Impor." action={<Link href="/penjualan/marketplace/impor" className="btn-primary">Impor file</Link>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Piutang (belum cair)" value={idr(sum.piutang)} tone="amber" hint={`${sum.piutangCount} pesanan`} />
            <Stat label="Cair" value={idr(sum.cair)} tone="green" hint="uang masuk saldo toko" />
            <Stat label="Biaya platform" value={idr(sum.fees)} hint="dari file penghasilan" />
            <Stat label="Retur/komplain" value={sum.retur} tone="red" hint="pesanan" />
          </div>
          <FilterBar>
            <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Kanal"><select name="kanal" defaultValue={sp.kanal ?? ""} className="input"><option value="">Semua</option><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
            <Field label="Dari"><input type="date" name="dari" defaultValue={sp.dari ?? ""} className="input" /></Field>
            <Field label="Sampai"><input type="date" name="sampai" defaultValue={sp.sampai ?? ""} className="input" /></Field>
            <Field label="Cari" className="col-span-2"><input name="q" defaultValue={sp.q ?? ""} placeholder="No. pesanan / resi / SKU" className="input" /></Field>
            <input type="hidden" name="tab" value={tab} />
          </FilterBar>
          <Tabs tabs={tabs} current={tab} />
          {rows.length === 0 ? (
            <Empty title="Tidak ada pesanan" hint="Ubah filter atau tab." />
          ) : (
            <div className="table-wrap">
              <Paged size={25}>
                <table className="tbl">
                  <thead><tr><th>No. pesanan</th><th>Kanal</th><th>Tgl</th><th>Produk</th><th className="num">Nilai</th><th className="num">Diterima</th><th>Status</th></tr></thead>
                  <tbody>
                    {rows.map((o) => {
                      const st = shownStatus(o.status, !!o.income);
                      return (
                        <tr key={o.id}>
                          <td><Link href={`/penjualan/marketplace/${o.id}`} className="link font-mono text-xs">{o.orderNo}</Link></td>
                          <td>{CHANNEL_LABEL[o.channel]}</td>
                          <td>{fmtDate(o.orderedAt)}</td>
                          <td className="max-w-[16rem] truncate">{o.lines.map((l) => `${l.name ?? l.sku ?? "-"} ×${l.qty}`).join(", ")}</td>
                          <td className="num">{idr(o.total)}</td>
                          <td className="num">{st === "BATAL" ? "0" : o.income ? idr(o.income.released) : "—"}</td>
                          <td><Badge tone={TONE[st]}>{STATUS_LABEL[st]}</Badge>{o.needsCheck && <Badge tone="amber">Cek</Badge>}{o.complaint && <Badge tone="red">Komplain</Badge>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Paged>
              {n(sum.count) > rows.length && <p className="p-2 text-xs text-slate-400">Menampilkan {rows.length} terbaru dari {sum.count} pesanan. Persempit dengan filter periode.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
