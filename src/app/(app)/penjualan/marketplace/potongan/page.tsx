import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { feeVsSettings, productActuals, unmappedColumns } from "@/lib/marketplace/potongan";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { FEE_CATEGORIES } from "@/lib/marketplace/feeMap";
import { Badge, Card, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { applyActualFeesAction, applyAffiliateAction, mapFeeAction } from "../actions";
import { MpNav } from "../MpNav";
import { periodOf } from "../periode";

export const metadata = { title: "Potongan Marketplace" };
const pc = (v: number) => `${v.toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;

export default async function PotonganPage({ searchParams }: { searchParams: Promise<{ toko?: string; kanal?: string; dari?: string; sampai?: string }> }) {
  const user = await requirePerm("sales.view");
  const canManage = user.can("sales.manage");
  const sp = await searchParams;
  const channel = sp.kanal === "TTS" ? "TTS" : "SHP";
  const { from, to } = await periodOf(sp);
  const f = { storeId: sp.toko || undefined, channel, from, to };
  const [stores, rep, prods, unmapped] = await Promise.all([prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }), feeVsSettings(f), productActuals(f), unmappedColumns()]);
  const hidden = (<><input type="hidden" name="channel" value={channel} /><input type="hidden" name="from" value={from} /><input type="hidden" name="to" value={to} /><input type="hidden" name="storeId" value={sp.toko ?? ""} /></>);
  return (
    <div className="space-y-4">
      <PageHeader title="Potongan Marketplace" subtitle="Dari harga jual sampai uang masuk saldo · tiap potongan dicatat per kategori" />
      <MpNav current="potongan" />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Kanal"><select name="kanal" defaultValue={channel} className="input"><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
        <Field label="Dari"><input type="date" name="dari" defaultValue={from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="sampai" defaultValue={to} className="input" /></Field>
      </FilterBar>
      {unmapped.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{unmapped.length} kolom biaya belum dipetakan ke kategori (belum ikut dijumlah; muncul sebagai selisih belum terjelaskan). Pilih kategorinya di bagian “Kolom biaya belum dipetakan” di bawah.</div>}
      {rep.orders === 0 ? <Empty title="Belum ada pesanan cair pada periode ini" hint="Unggah file penghasilan di menu Impor." /> : (
        <>
          <Card title={`${CHANNEL_LABEL[channel]} · ${rep.orders.toLocaleString("id-ID")} pesanan cair`}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Komponen</th><th className="num">Rp</th><th className="num">% harga jual</th></tr></thead>
                <tbody>
                  <tr className="font-medium"><td>Harga jual (gross)</td><td className="num">{idr(rep.gross)}</td><td className="num">100%</td></tr>
                  {rep.rows.filter((r) => r.counted).map((r) => <tr key={r.category}><td>{r.label}</td><td className="num">{idr(r.value)}</td><td className="num">{pc(r.pct)}</td></tr>)}
                  {Object.entries(rep.unmapped).map(([c, v]) => <tr key={c}><td>{c} <Badge tone="amber">Belum dipetakan</Badge></td><td className="num">{idr(v)}</td><td className="num">{rep.gross ? pc((Math.abs(v) / rep.gross) * 100) : "-"}</td></tr>)}
                  <tr className="font-semibold"><td>Masuk saldo (cair)</td><td className="num">{idr(rep.released)}</td><td className="num">{rep.gross ? pc((rep.released / rep.gross) * 100) : "-"}</td></tr>
                  <tr><td>Selisih belum terjelaskan</td><td className="num">{idr(rep.residual)}</td><td className="num">{rep.residual === 0 ? <Badge tone="green">Cocok</Badge> : <Badge tone="amber">Cek</Badge>}</td></tr>
                </tbody>
              </table>
            </div>
            {rep.rows.some((r) => !r.counted) && (
              <div className="mt-3 border-t pt-2 text-xs text-slate-500">
                <p className="mb-1 font-medium">Rincian &amp; info (tidak dijumlah ke potongan)</p>
                <ul>{rep.rows.filter((r) => !r.counted).map((r) => <li key={r.category} className="flex justify-between"><span>{r.label}</span><span>{idr(r.value)}</span></li>)}</ul>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">Selisih = cair − (harga jual + potongan yang sudah dipetakan). Kolom “Belum dipetakan” tidak ikut dijumlah sampai dipetakan. Selisih bukan nol berarti ada komponen di file yang belum tertangkap (mis. selisih ongkir); periksa kolom biayanya.</p>
          </Card>
          {(rep.adsInfo.topup > 0 || rep.adsInfo.usage > 0 || rep.adsInfo.walletBalance !== 0) && (
            <Card title="Iklan Shopee (saldo iklan)">
              <dl className="grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-slate-500">Biaya iklan aktual (pemakaian)</dt><dd className="text-right font-medium">{idr(rep.adsInfo.usage)}</dd>
                <dt className="text-slate-500">Isi saldo iklan dari saldo penjual</dt><dd className="text-right">{idr(rep.adsInfo.topup)}</dd>
                <dt className="text-slate-500">└ termasuk PPN 11% (perkiraan)</dt><dd className="text-right">{idr(rep.adsInfo.ppn)}</dd>
                <dt className="text-slate-500">Saldo iklan tersisa (isi saldo − pemakaian)</dt><dd className="text-right">{idr(rep.adsInfo.walletBalance)}</dd>
              </dl>
              <p className="mt-2 text-xs text-slate-500">Biaya iklan di tabel di atas memakai pemakaian aktual dari file “saldo iklan” (adwords_bill). Isi saldo hanya mengurangi saldo penjual, bukan biaya.</p>
            </Card>
          )}
          <Card title="Angka aktual vs pengaturan harga" actions={canManage && rep.enough ? (
            <ActionForm action={applyActualFeesAction} confirm="Pakai angka aktual sebagai pengaturan biaya marketplace? Ini hanya mengubah saran harga (Produk › Biaya), bukan transaksi.">{hidden}<Submit className="btn-secondary" pendingText="Menyimpan…">Pakai angka aktual</Submit></ActionForm>
          ) : undefined}>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Biaya</th><th className="num">Pengaturan</th><th className="num">Aktual</th><th className="num">Selisih</th></tr></thead>
                <tbody>
                  {rep.settingRows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{r.setting === null ? "-" : pc(r.setting)}</td><td className="num">{pc(r.actual)}</td><td className="num">{r.diff === null ? "-" : `${r.diff > 0 ? "+" : ""}${pc(r.diff)}`}</td></tr>)}
                  <tr><td>Biaya per pesanan (proses)</td><td className="num">{rep.perOrder.setting === null ? "-" : idr(rep.perOrder.setting)}</td><td className="num">{idr(rep.perOrder.actual)}</td><td className="num">{rep.perOrder.setting === null ? "-" : idr(rep.perOrder.actual - rep.perOrder.setting)}</td></tr>
                </tbody>
              </table>
            </div>
            {!rep.enough && <p className="mt-2 text-xs text-slate-500">Tombol muncul bila ada minimal 20 pesanan cair pada periode ini.</p>}
          </Card>
          <Card title="Affiliate per produk (aktual)" actions={canManage && prods.length ? (
            <ActionForm action={applyAffiliateAction} confirm="Isi % affiliate tiap produk dengan angka aktual? Hanya mengubah pengaturan produk (Produk › Biaya).">{hidden}<Submit className="btn-secondary" pendingText="Menyimpan…">Pakai angka aktual</Submit></ActionForm>
          ) : undefined}>
            {prods.length === 0 ? <p className="text-sm text-slate-500">Belum cukup data per produk (minimal 10 pesanan per produk, SKU harus sudah dipetakan).</p> : (
              <div className="table-wrap"><table className="tbl"><thead><tr><th>Produk</th><th className="num">Pesanan</th><th className="num">Omzet</th><th className="num">Komisi affiliate</th><th className="num">% aktual</th></tr></thead>
                <tbody>{prods.map((p) => <tr key={p.itemId}><td>{p.name}</td><td className="num">{p.orders}</td><td className="num">{idr(p.gross)}</td><td className="num">{idr(Math.round(p.affiliate))}</td><td className="num">{pc(p.affiliatePct)}</td></tr>)}</tbody></table></div>
            )}
            <p className="mt-2 text-xs text-slate-500">Biaya per pesanan dialokasikan ke produk sebanding dengan nilai barisnya. Iklan ditampilkan per kanal di tabel potongan di atas.</p>
          </Card>
        </>
      )}
      <Card title={`Kolom biaya belum dipetakan (${unmapped.length})`}>
        {unmapped.length === 0 ? <p className="text-sm text-slate-500">Semua kolom biaya yang ada di file sudah punya kategori.</p> : (
          <div className="space-y-2">
            {unmapped.map((u) => (
              <div key={u.platform + u.column} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2 text-sm">
                <span className="min-w-0 flex-1"><b>{u.column}</b> <span className="text-slate-400">· {u.platform === "SHOPEE" ? "Shopee" : "TikTok"} · {u.rows} baris · {idr(u.total)}</span></span>
                {canManage && (
                  <ActionForm action={mapFeeAction} className="flex items-center gap-2">
                    <input type="hidden" name="platform" value={u.platform} /><input type="hidden" name="column" value={u.column} />
                    <select name="category" className="input w-auto" required defaultValue=""><option value="" disabled>Pilih kategori…</option>{Object.entries(FEE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                    <Submit className="btn-secondary" pendingText="…">Simpan</Submit>
                  </ActionForm>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">Pemetaan dipakai ulang di semua pesanan, juga yang sudah diimpor.</p>
      </Card>
    </div>
  );
}
