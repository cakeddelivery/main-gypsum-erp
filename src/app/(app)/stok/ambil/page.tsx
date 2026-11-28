import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { TAKE_DIVISIONS, ambilHistory, keringStock, type TakeDivision } from "@/lib/ambilStok";
import { fmtDateTime } from "@/lib/time";
import { Card, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { balikAmbil, cancelAmbilAction, saveAmbil } from "./actions";

export const metadata = { title: "Ambil Stok" };
const fmt = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 3 });
const PRESETS = [5, 10, 20, 50, 100];

export default async function AmbilPage({ searchParams }: { searchParams: Promise<{ div?: string; item?: string; balik?: string }> }) {
  const user = await requirePerm("stock.take");
  const sp = await searchParams;
  const own = user.divisionId ? (await prisma.division.findUnique({ where: { id: user.divisionId }, select: { reportTemplate: true } }))?.reportTemplate : null;
  const division: TakeDivision = sp.div === "GIFTBOX" || sp.div === "ASSEMBLING" ? sp.div : own === "GIFTBOX" ? "GIFTBOX" : "ASSEMBLING";
  const balik = sp.balik === "1";
  const [stock, hist] = await Promise.all([keringStock(division), ambilHistory(20)]);
  const chosen = stock.find((s) => s.id === sp.item);
  const act = balik ? balikAmbil : saveAmbil;
  const avail = chosen ? (balik ? chosen.mine : chosen.oven) : 0;
  const qs = (o: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ div: division, ...(balik ? { balik: "1" } : {}), ...o })) if (v) p.set(k, v); return `/stok/ambil?${p}`; };
  return (
    <div className="space-y-4">
      <PageHeader title={balik ? "Kembalikan ke Oven" : "Ambil stok patung kering"} subtitle={`Dari Oven ke stok ${TAKE_DIVISIONS[division].label} · tidak mengubah laba rugi`} actions={<Link href={`/stok/ambil?div=${division}${balik ? "" : "&balik=1"}`} className="btn-secondary">{balik ? "Ambil dari Oven" : "Kembalikan sisa"}</Link>} />
      <div className="flex gap-2">
        {(Object.keys(TAKE_DIVISIONS) as TakeDivision[]).map((d) => <Link key={d} href={`/stok/ambil?div=${d}${balik ? "&balik=1" : ""}`} className={`btn h-11 flex-1 text-base ${d === division ? "btn-primary" : "btn-secondary"}`}>{TAKE_DIVISIONS[d].label}</Link>)}
      </div>
      {!chosen ? (
        <Card title={`1. Ketuk karakter (${balik ? `stok ${TAKE_DIVISIONS[division].label}` : "stok di Oven"})`}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {stock.map((s) => { const q = balik ? s.mine : s.oven; return (
              <Link key={s.id} href={qs({ item: s.id })} className={`rounded-xl border px-3 py-4 text-center ${q > 0 ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
                <div className="text-base font-bold">{s.name.replace(/^Patung Kering\s*/i, "")}</div>
                <div className="text-sm tabular-nums">{fmt(q)} {s.unit}</div>
                <div className="text-[11px] text-slate-500">{balik ? `Oven ${fmt(s.oven)}` : `${TAKE_DIVISIONS[division].label} ${fmt(s.mine)}`}</div>
              </Link>); })}
            {!stock.length && <p className="col-span-full text-sm text-slate-500">Belum ada barang patung kering (SJ-PTG-…).</p>}
          </div>
        </Card>
      ) : (
        <Card title={`2. ${chosen.name} · tersedia ${fmt(avail)} ${chosen.unit}`}>
          <ActionForm action={act} className="space-y-3">
            <input type="hidden" name="itemId" value={chosen.id} />
            <input type="hidden" name="division" value={division} />
            <div className="grid grid-cols-5 gap-2">
              {PRESETS.map((q) => <button key={q} name="qty" value={q} disabled={q > avail} className="btn-primary h-14 text-lg disabled:opacity-30">{q}</button>)}
            </div>
            <div className="flex items-end gap-2">
              <label className="flex-1 text-sm">Jumlah lain<input name="qtyCustom" inputMode="decimal" className="input h-12 text-base" placeholder="mis. 37" /></label>
              <Submit>{balik ? "Kembalikan" : "Ambil"}</Submit>
            </div>
          </ActionForm>
          <Link href={qs({})} className="mt-3 inline-block text-sm text-slate-500 underline">← ganti karakter</Link>
        </Card>
      )}
      <Card title="Riwayat ambil stok">
        <div className="table-wrap"><table className="tbl"><thead><tr><th>Nomor</th><th>Waktu</th><th>Barang</th><th className="num">Qty</th><th>Dari → Ke</th><th>Oleh</th><th /></tr></thead>
          <tbody>
            {hist.map((h) => (
              <tr key={h.id} className={h.cancelled ? "text-slate-400 line-through" : ""}>
                <td className="font-mono text-xs">{h.number}</td><td>{fmtDateTime(h.date)}</td><td>{h.item}</td><td className="num">{fmt(h.qty)} {h.unit}</td><td className="text-xs">{h.from} → {h.to}</td><td>{h.by}</td>
                <td>{!h.cancelled && user.can("stock.approve") && (
                  <ActionForm action={cancelAmbilAction} className="flex gap-1"><input type="hidden" name="number" value={h.number} /><input name="reason" placeholder="Alasan batal" className="input w-28 py-1 text-xs" required /><Submit className="btn-danger btn-sm" confirm="Batalkan? Stok dikembalikan ke posisi semula.">Batal</Submit></ActionForm>
                )}</td>
              </tr>
            ))}
            {!hist.length && <tr><td colSpan={7} className="text-center text-slate-500">Belum ada</td></tr>}
          </tbody></table></div>
      </Card>
    </div>
  );
}
