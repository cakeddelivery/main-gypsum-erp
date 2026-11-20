import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { idr } from "@/lib/money";
import { todayStr } from "@/lib/time";
import { CHANNEL_LABEL } from "@/lib/marketplace/rules";
import { reconcile } from "@/lib/marketplace/report";
import { Badge, Card, Empty, Field, FilterBar, PageHeader } from "@/components/ui";
import { MpNav } from "../MpNav";

export const metadata = { title: "Rekonsiliasi Marketplace" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function RekonPage({ searchParams }: { searchParams: Promise<{ toko?: string; dari?: string; sampai?: string }> }) {
  await requirePerm("sales.view");
  const sp = await searchParams;
  const last = await prisma.marketplaceIncome.findFirst({ where: { releasedAt: { not: null } }, orderBy: { releasedAt: "desc" }, select: { releasedAt: true } });
  const base = (last?.releasedAt ? new Date(last.releasedAt.getTime() + 7 * 3600000) : new Date()).toISOString().slice(0, 7);
  const from = DATE.test(sp.dari ?? "") ? sp.dari! : `${base}-01`;
  const to = DATE.test(sp.sampai ?? "") ? sp.sampai! : todayStr();
  const [stores, rows] = await Promise.all([prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true } }), reconcile({ storeId: sp.toko || undefined, from, to })]);
  return (
    <div className="space-y-4">
      <PageHeader title="Rekonsiliasi" subtitle="Uang cair (file penghasilan) dibanding withdraw yang sudah dicatat di Keuangan · hanya laporan, tidak membuat transaksi" />
      <MpNav current="rekon" />
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Dari"><input type="date" name="dari" defaultValue={from} className="input" /></Field>
        <Field label="Sampai"><input type="date" name="sampai" defaultValue={to} className="input" /></Field>
      </FilterBar>
      {rows.length === 0 ? <Empty title="Belum ada data cair pada periode ini" hint="Unggah file penghasilan di menu Impor." /> : (
        <Card>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Toko</th><th>Kanal</th><th className="num">Pesanan cair</th><th className="num">Total cair</th><th className="num">Iklan GMV</th><th className="num">Penyesuaian</th><th className="num">Withdraw tercatat</th><th className="num">Selisih</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.storeId + r.channel}>
                    <td>{r.store}</td><td>{CHANNEL_LABEL[r.channel]}</td><td className="num">{r.orders}</td><td className="num">{idr(r.cair)}</td><td className="num">{idr(r.ads)}</td><td className="num">{idr(r.adjust)}</td><td className="num">{idr(r.recorded)}</td>
                    <td className="num">{idr(r.diff)}</td>
                    <td>{r.noBank ? <Badge tone="amber">Rekening marketplace belum ada</Badge> : r.diff === 0 ? <Badge tone="green">Cocok</Badge> : <Badge tone="amber">Selisih</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">Selisih = cair + iklan GMV + penyesuaian − withdraw tercatat. Withdraw diambil dari transfer keluar rekening saldo marketplace di Keuangan untuk toko yang sama. Riwayat penarikan TikTok di file: {rows.filter((r) => r.channel === "TTS").map((r) => idr(r.tiktokWithdraw)).join(" / ") || "-"}.</p>
        </Card>
      )}
    </div>
  );
}
