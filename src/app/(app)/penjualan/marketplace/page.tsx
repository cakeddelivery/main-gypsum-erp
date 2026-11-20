import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr, n } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { CHANNEL_LABEL, shownStatus, STATUS_LABEL, type ShownStatus } from "@/lib/marketplace/rules";
import { listOrders, orderSummary, type Tab } from "@/lib/marketplace/report";
import { unloggedCounts } from "@/lib/marketplace/lookup";
import { Badge, Empty, Field, FilterBar, PageHeader, Stat, Tabs } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { ImportBannerServer } from "@/components/ImportBannerServer";
import { MpNav } from "./MpNav";

export const metadata = { title: "Pesanan Marketplace" };
type SP = { toko?: string; kanal?: string; dari?: string; sampai?: string; tab?: string; q?: string };
const TONE: Record<ShownStatus, "amber" | "green" | "gray" | "red" | "blue"> = { PIUTANG: "amber", CAIR: "blue", DITARIK: "green", BATAL: "gray", RETUR: "red" };
const TAB_LABEL: Record<Tab, string> = { ALL: "Semua", PIUTANG: "Piutang", CAIR: "Di saldo", DITARIK: "Ditarik", BATAL: "Batal", RETUR: "Retur/Komplain" };
const TABS: Tab[] = ["ALL", "PIUTANG", "CAIR", "DITARIK", "BATAL", "RETUR"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function MarketplacePage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requirePerm("sales.view");
  const canLog = user.can("retur.manage") || user.can("refund.request");
  const sp = await searchParams;
  const tab = (TABS.includes((sp.tab ?? "") as Tab) ? sp.tab : "ALL") as Tab;
  const f = { storeId: sp.toko || undefined, channel: sp.kanal === "SHP" || sp.kanal === "TTS" ? sp.kanal : undefined, from: DATE.test(sp.dari ?? "") ? sp.dari : undefined, to: DATE.test(sp.sampai ?? "") ? sp.sampai : undefined, q: sp.q };
  const [stores, sum, rows, noData, unlogged] = await Promise.all([
    prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }),
    orderSummary(f),
    listOrders({ ...f, tab }, 300),
    prisma.marketplaceOrder.count({ take: 1 }).then((c) => c === 0),
    unloggedCounts({ storeId: f.storeId, channel: f.channel }),
  ]);
  const qs = (t: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ toko: sp.toko, kanal: sp.kanal, dari: sp.dari, sampai: sp.sampai, q: sp.q, tab: t })) if (v && !(k === "tab" && t === "ALL")) p.set(k, v);
    return `/penjualan/marketplace${p.size ? `?${p}` : ""}`;
  };
  const tabs = TABS.map((t) => ({ key: t, label: TAB_LABEL[t], href: qs(t), count: sum.counts[t] }));
  return (
    <div className="space-y-4">
      <PageHeader title="Pesanan Marketplace" subtitle="Shopee & TikTok Shop dari file Excel · tidak mengubah stok maupun jurnal" actions={<Link href="/penjualan/offline" className="btn-secondary">Penjualan</Link>} />
      <MpNav current="pesanan" />
      <ImportBannerServer />
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Angka marketplace = data operasional dari file; tidak masuk jurnal. Pendapatan akuntansi dicatat dari withdraw — jangan dijumlahkan dengan laporan Laba.</p>
      {noData ? (
        <Empty title="Belum ada pesanan marketplace" hint="Unggah file Order & Penghasilan dari Seller Center di menu Impor." action={<Link href="/penjualan/marketplace/impor" className="btn-primary">Impor file</Link>} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Piutang (belum cair)" value={idr(sum.piutang)} tone="amber" hint={`${sum.piutangCount} pesanan`} />
            <Stat label="Saldo di marketplace" value={idr(sum.saldo)} tone="blue" hint="cair, belum ditarik" />
            <Stat label="Sudah ditarik bulan ini" value={idr(sum.withdrawnMonth)} tone="green" hint="withdraw ke rekening" />
            <Stat label="Potongan platform" value={idr(sum.fees)} hint="komponen yang mengurangi saldo" />
            <Stat label="Retur/komplain" value={sum.retur} tone="red" hint={`${unlogged.fromFile} retur dari file · ${unlogged.logged} sudah dicatat di ERP`} />
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
                  <thead><tr><th>No. pesanan</th><th>Kanal</th><th>Tgl</th><th>Produk</th><th className="num">Nilai</th><th className="num">Diterima</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((o) => {
                      const st = shownStatus(o.status, !!o.income, !!o.income && (o.cover?.withdrawn ?? 0) >= Number(o.income.released) && Number(o.income.released) > 0);
                      return (
                        <tr key={o.id}>
                          <td><Link href={`/penjualan/marketplace/${o.id}`} className="link font-mono text-xs">{o.orderNo}</Link></td>
                          <td>{CHANNEL_LABEL[o.channel]}</td>
                          <td>{fmtDate(o.orderedAt)}</td>
                          <td className="max-w-[16rem] truncate">{o.lines.map((l) => `${l.name ?? l.sku ?? "-"} ×${l.qty}`).join(", ")}</td>
                          <td className="num">{idr(o.total)}</td>
                          <td className="num">{st === "BATAL" ? "0" : o.income ? idr(o.income.released) : "—"}</td>
                          <td><Badge tone={TONE[st]}>{STATUS_LABEL[st]}</Badge>{st === "CAIR" && (o.cover?.withdrawn ?? 0) > 0 && <Badge tone="blue">sebagian ditarik</Badge>}{o.needsCheck && <Badge tone="amber">Cek</Badge>}{o.complaint && <Badge tone="red">Komplain</Badge>}{(o.status === "RETUR" && !o.returnCaseId || o.complaint && !o.complaintId) && <Badge tone="amber">Belum dicatat</Badge>}</td>
                          <td className="whitespace-nowrap">{canLog && o.status === "RETUR" && !o.returnCaseId && <Link href={`/retur?dari=${o.id}`} className="btn-secondary btn-sm">Catat retur</Link>}{canLog && (o.status === "RETUR" || o.complaint) && !o.complaintId && <Link href={`/retur/komplain?dari=${o.id}`} className="btn-secondary btn-sm ml-1">Catat komplain</Link>}{o.returnCaseId && <Badge tone="green">Retur tercatat</Badge>}</td>
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
