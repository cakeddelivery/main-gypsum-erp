import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { accountBalances, COA } from "@/lib/accounting";
import { inventoryValuation } from "@/lib/stock";
import { idr } from "@/lib/money";
import { fmtDateTime, jakartaParts, MONTHS } from "@/lib/time";
import { Badge, Card, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { BackLink } from "../shared";
import { close, reopen } from "../actions";

export const metadata = { title: "Tutup Buku" };

export default async function TutupBuku() {
  const user = await requirePerm("accounting.view");
  const p = jakartaParts();
  const months = Array.from({ length: 12 }, (_, i) => { const m = ((p.month - 1 - i + 24) % 12) + 1; const y = p.year - (p.month - 1 - i < 0 ? 1 : 0); return { y, m }; });
  const [periods, pending, auto, inv, bal] = await Promise.all([
    prisma.accountingPeriod.findMany(),
    prisma.financeTransaction.count({ where: { status: { in: ["DRAFT", "PERLU_DITINJAU", "MENUNGGU_KONFIRMASI"] } } }),
    prisma.setting.findUnique({ where: { key: "auto_close_enabled" } }),
    inventoryValuation(),
    accountBalances({}),
  ]);
  const gl = (code: string) => bal.find((a) => a.code === code)?.balance ?? 0;
  const recon = [
    { label: "Bahan baku", stock: inv.byType.BAHAN_BAKU, gl: gl(COA.PERSEDIAAN_BAHAN) },
    { label: "Barang dalam proses", stock: inv.byType.BARANG_DALAM_PROSES, gl: gl(COA.PERSEDIAAN_BDP) },
    { label: "Barang jadi", stock: inv.byType.BARANG_JADI, gl: gl(COA.PERSEDIAAN_JADI) },
  ];
  return (
    <div className="space-y-5">
      <PageHeader title="Tutup buku bulanan" subtitle={`Otomatis setiap tanggal 1 pukul 09.00 WIB (${(auto?.value ?? "true") === "true" ? "aktif" : "nonaktif"}) · periode tertutup menolak pembukuan baru`} actions={<BackLink />} />
      {pending > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">Masih ada {pending} transaksi di Finance Inbox yang belum final. Selesaikan sebelum menutup periode.</div>}
      <Card title="Periode">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Periode</th><th>Status</th><th>Ditutup</th><th /></tr></thead>
            <tbody>
              {months.map(({ y, m }) => {
                const per = periods.find((x) => x.year === y && x.month === m);
                const closed = per?.status === "CLOSED";
                const isCurrent = y === p.year && m === p.month;
                return (
                  <tr key={`${y}-${m}`}>
                    <td>{MONTHS[m - 1]} {y}</td>
                    <td>{closed ? <Badge tone="green">Ditutup</Badge> : <Badge tone="amber">Terbuka</Badge>}</td>
                    <td className="text-xs">{per?.closedAt ? `${fmtDateTime(per.closedAt)} · ${per.closedBy}` : "-"}</td>
                    <td>
                      {!closed && !isCurrent && user.can("accounting.close") && <ActionForm action={close} confirm={`Tutup buku ${MONTHS[m - 1]} ${y}? Penyusutan akan dibukukan dan periode dikunci.`}><input type="hidden" name="year" value={y} /><input type="hidden" name="month" value={m} /><Submit className="btn-primary btn-sm">Tutup buku</Submit></ActionForm>}
                      {closed && user.role === "OWNER" && (
                        <Modal trigger="Buka kembali" triggerClass="btn-secondary btn-sm" title={`Buka kembali ${MONTHS[m - 1]} ${y}`}>
                          <ModalForm action={reopen} className="space-y-3"><input type="hidden" name="year" value={y} /><input type="hidden" name="month" value={m} /><Field label="Alasan (tercatat di audit log)"><input name="reason" className="input" required /></Field><Submit className="btn-danger">Buka kembali</Submit></ModalForm>
                        </Modal>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Rekonsiliasi persediaan: stok vs buku besar">
        <table className="tbl">
          <thead><tr><th>Jenis</th><th className="num">Nilai stok</th><th className="num">Saldo buku besar</th><th className="num">Selisih</th></tr></thead>
          <tbody>{recon.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{idr(r.stock)}</td><td className="num">{idr(r.gl)}</td><td className={`num ${Math.abs(r.stock - r.gl) > 1000 ? "text-rose-600" : "text-emerald-600"}`}>{idr(r.stock - r.gl)}</td></tr>)}</tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">Selisih wajar muncul bila pembelian belum dibukukan di Finance atau ada saldo awal persediaan yang belum diinput. Gunakan jurnal penyesuaian bila perlu.</p>
      </Card>
    </div>
  );
}
