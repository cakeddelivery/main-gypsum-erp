import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { bongkarPlan } from "@/lib/bongkarRetur";
import { workshopItems } from "@/lib/produksiWorkshop";
import { REJECT_REASONS } from "@/lib/rejectShared";
import { fmtDateTime, todayStr } from "@/lib/time";
import { Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { cancelBongkarAction, saveBongkar } from "./actions";

export const metadata = { title: "Bongkar Retur" };
const fmt = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });

export default async function BongkarPage({ searchParams }: { searchParams: Promise<{ item?: string; qty?: string; retur?: string }> }) {
  const user = await requirePerm("stock.produce", "retur.manage");
  const sp = await searchParams;
  const items = await workshopItems();
  const qty = Number((sp.qty ?? "").replace(",", "."));
  const plan = sp.item && qty > 0 ? await bongkarPlan(prisma, sp.item, qty).catch(() => null) : null;
  const rows = await prisma.stockMovement.findMany({ where: { ref: { startsWith: "BRT:" }, type: "KONSUMSI_PRODUKSI" }, orderBy: { date: "desc" }, take: 30, include: { item: { select: { name: true, unit: true } } } });
  const cancelled = new Set((await prisma.stockMovement.findMany({ where: { ref: { in: rows.map((r) => `BATAL-${r.ref}`) } }, select: { ref: true } })).map((r) => r.ref!.replace(/^BATAL-/, "")));
  return (
    <div className="space-y-5">
      <PageHeader title="Bongkar retur" subtitle="Bongkar barang retur ke isinya; tandai komponen yang RUSAK, sisanya kembali ke stok" actions={<><Link href="/stok/workshop?mode=ras" className="btn-secondary">Rakit ulang</Link><Link href="/retur" className="btn-secondary">Retur</Link></>} />
      <Card title="1. Pilih barang retur & jumlah">
        <form method="get" className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <Field label="Barang (paket / Single Pack)"><select name="item" defaultValue={sp.item ?? ""} className="input h-12 text-base" required><option value="">— pilih —</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select></Field>
          <Field label="Jumlah"><input name="qty" inputMode="decimal" defaultValue={sp.qty ?? ""} className="input h-12 text-base" required /></Field>
          <button className="btn-primary h-12 text-base">Lihat isi ▶</button>
        </form>
      </Card>
      {plan && (
        <Card title={`2. Isi ${fmt(plan.qty)} ${plan.item.unit} ${plan.item.name}: tandai yang rusak`}>
          <ActionForm action={saveBongkar} className="space-y-3">
            <input type="hidden" name="itemId" value={plan.item.id} />
            <input type="hidden" name="qty" value={plan.qty} />
            <div className="space-y-2">
              {plan.lines.map((l) => (
                <label key={l.itemId} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                  <span className="min-w-0 text-sm"><b>{l.name}</b><span className="block text-xs text-slate-500">isi {fmt(l.total)} {l.unit}</span></span>
                  <span className="flex shrink-0 items-center gap-1"><span className="text-xs text-rose-600">rusak</span><input name={`d.${l.itemId}`} inputMode="decimal" defaultValue="0" className="input w-24 text-right" aria-label={`Rusak ${l.name}`} /><span className="text-xs text-slate-500">{l.unit}</span></span>
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Penyebab rusak"><select name="reason" className="input" defaultValue="PECAH">{Object.entries(REJECT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="No. retur (RTR-…)"><input name="returnNumber" defaultValue={sp.retur ?? ""} className="input" placeholder="opsional" /></Field>
              <Field label="Tanggal"><input type="date" name="date" defaultValue={todayStr()} className="input" /></Field>
              <Field label="Catatan"><input name="note" className="input" /></Field>
            </div>
            <p className="text-xs text-slate-500">Barang retur keluar dari stoknya; komponen layak masuk stok (nilai proporsional); komponen rusak jadi reject (Beban Reject 6-1800, tampil di laporan reject). Jurnal retur penjualan (RTR) tidak diubah.</p>
            <Submit>Simpan bongkar</Submit>
          </ActionForm>
        </Card>
      )}
      <Card title="Riwayat">
        <div className="table-wrap"><table className="tbl"><thead><tr><th>Nomor</th><th>Waktu</th><th>Barang</th><th className="num">Qty</th><th>Oleh</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cancelled.has(r.ref!) ? "text-slate-400 line-through" : ""}>
                <td className="font-mono text-xs">{r.ref!.slice(4)}</td><td>{fmtDateTime(r.date)}</td><td>{r.item.name}</td><td className="num">{fmt(Number(r.qty))} {r.item.unit}</td><td>{r.createdBy}</td>
                <td>{!cancelled.has(r.ref!) && user.can("stock.approve") && (
                  <ActionForm action={cancelBongkarAction} className="flex gap-1"><input type="hidden" name="number" value={r.ref!.slice(4)} /><input name="reason" placeholder="Alasan batal" className="input w-32 py-1 text-xs" required /><Submit className="btn-danger btn-sm" confirm="Batalkan bongkar ini? Stok, jurnal & catatan reject dibalik.">Batal</Submit></ActionForm>
                )}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="text-center text-slate-500">Belum ada bongkar retur</td></tr>}
          </tbody></table></div>
      </Card>
    </div>
  );
}
