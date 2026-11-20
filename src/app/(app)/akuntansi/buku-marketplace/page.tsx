import { requirePerm } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { n, idr } from "@/lib/money";
import { fmtDate } from "@/lib/time";
import { COA } from "@/lib/accounting";
import { WITHDRAW_INCOME_SOURCE } from "@/lib/finance";
import { latestMonth } from "@/lib/marketplace/dashboard";
import { integrityCheck } from "@/lib/marketplace/integrity";
import { GL_ACCOUNTS, GL_DEFAULT_OPEN, glOpenDate, glTrialBalance, saldoIklan, saldoPenjual, suggestOpening, type Wallet } from "@/lib/marketplace/gl";
import { Badge, Card, Empty, Field, FilterBar, PageHeader, Stat } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { rebuildGlAction, saveGlOpeningAction } from "./actions";

export const metadata = { title: "Buku Bayangan Marketplace" };
const CH = { SHP: "Shopee", TTS: "TikTok" } as const;

/** Mode SIMULASI: jurnal penuh marketplace (Opsi B) dihitung di buku terpisah; Neraca/Laba Rugi nyata TIDAK berubah. */
export default async function BukuMarketplace({ searchParams }: { searchParams: Promise<{ toko?: string; kanal?: string }> }) {
  const user = await requirePerm("accounting.view");
  const canPost = user.can("accounting.post");
  const sp = await searchParams;
  const storeId = sp.toko || undefined;
  const channel = sp.kanal === "SHP" || sp.kanal === "TTS" ? sp.kanal : undefined;
  const openDate = await glOpenDate();
  const stores = await prisma.store.findMany({ where: { active: true, code: { in: ["MG", "DL"] } }, orderBy: { code: "asc" }, select: { id: true, name: true, code: true } });
  const month = await latestMonth();
  const [tb, journals, openings, count, real, integ] = await Promise.all([
    glTrialBalance({ storeId, channel }),
    prisma.marketplaceGlJournal.findMany({ where: { ...(storeId ? { storeId } : {}), ...(channel ? { channel } : {}) }, orderBy: [{ date: "desc" }, { key: "asc" }], take: 120, include: { lines: true } }),
    prisma.marketplaceGlOpening.findMany(),
    prisma.marketplaceGlJournal.count(),
    // pendapatan nyata dari withdraw (cara lama) sejak tanggal saldo pembuka, sebagai pembanding berdampingan
    prisma.journalLine.aggregate({ where: { account: { code: COA.PENJUALAN }, journal: { source: WITHDRAW_INCOME_SOURCE, reversalOfId: null, date: { gt: new Date(`${openDate}T17:00:00Z`) }, ...(storeId ? { storeId } : {}) } }, _sum: { credit: true } }),
    integrityCheck({ month }).catch(() => null),
  ]);
  const rows = stores.flatMap((s) => ([["SHP", "PENJUAL"], ["SHP", "IKLAN"], ["TTS", "PENJUAL"]] as [string, Wallet][]).map(([ch, w]) => ({ s, ch, w, acct: w === "IKLAN" ? saldoIklan(s.code) : saldoPenjual(s.code, ch) })));
  const sugg = await Promise.all(rows.map((r) => suggestOpening(r.s.id, r.ch, r.w, openDate)));
  const saved = new Map(openings.map((o) => [`${o.storeId}|${o.channel}|${o.wallet}`, o]));
  const filled = rows.filter((r) => saved.has(`${r.s.id}|${r.ch}|${r.w}`)).length;
  const plug = tb.rows.find((r) => r.code === "6-1640")?.balance ?? 0;
  const shadowRevenue = tb.rows.find((r) => r.code === "4-1100");
  const checks: [string, boolean, string][] = [
    ["Saldo pembuka terisi (6 saldo: Shopee penjual & iklan, TikTok penjual × 2 toko)", filled === rows.length, `${filled}/${rows.length} terisi`],
    ["Tanggal saldo pembuka = 30 Nov 2026 (saat aktivasi; sekarang tanggal simulasi)", openDate === "2026-11-30", `sekarang ${openDate}`],
    ["Cek Integritas bulan terbaru tanpa temuan", !!integ && integ.failed === 0, integ ? `${integ.failed} dari ${integ.total} pemeriksaan gagal (${month})` : "tidak bisa dihitung"],
    ["Tidak ada selisih belum terjelaskan (6-1640) di buku bayangan", plug === 0, plug ? `${idr(plug)} — periksa pemetaan biaya / kolom yang belum dipetakan` : "nol"],
    ["Menu “Biaya marketplace” bulanan (manual) dihentikan sesudah aktif, agar tidak dobel", false, "aturan saat aktivasi"],
    ["Pengakuan pendapatan dari withdraw dimatikan sesudah aktif, agar tidak dobel", false, "aturan saat aktivasi"],
    ["Owner menyetujui angka bayangan vs Seller Center", false, "persetujuan Owner"],
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Buku bayangan marketplace" subtitle="Mode SIMULASI — jurnal penuh dihitung dari data impor di buku terpisah; Neraca & Laba Rugi nyata tidak berubah" actions={canPost && (
        <ActionForm action={rebuildGlAction}><Submit className="btn-secondary" pendingText="Membangun…">Bangun ulang</Submit></ActionForm>
      )} />
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"><b>SIMULASI.</b> Jurnal di sini tidak masuk Jurnal umum, Neraca, atau Laba Rugi. Pembukuan nyata mulai 1 Des 2026 hanya setelah Owner mengaktifkan (belum tersedia di versi ini). Tanggal saldo pembuka simulasi: {openDate} (bawaan {GL_DEFAULT_OPEN}).</div>
      <FilterBar>
        <Field label="Toko"><select name="toko" defaultValue={sp.toko ?? ""} className="input"><option value="">Semua</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Kanal"><select name="kanal" defaultValue={sp.kanal ?? ""} className="input"><option value="">Semua</option><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
      </FilterBar>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Jurnal bayangan" value={String(count)} />
        <Stat label="Penjualan marketplace (bayangan)" value={idr(tb.pendapatan)} hint={shadowRevenue ? "4-1100 dikurangi retur 4-1190" : ""} tone="green" />
        <Stat label="Beban marketplace (bayangan)" value={idr(tb.beban)} tone="red" />
        <Stat label="Laba kotor marketplace (bayangan)" value={idr(tb.laba)} tone="blue" />
      </div>
      <Card title="Pembanding dengan pembukuan nyata">
        <p className="text-sm text-slate-600">Cara nyata sekarang mengakui pendapatan saat <b>withdraw</b> ({idr(n(real._sum.credit))} sejak {openDate}); buku bayangan mengakui saat <b>pencairan pesanan</b> ({idr(tb.pendapatan)} bersih retur). Dua angka ini berbeda cara & waktu, ditampilkan berdampingan dan tidak dijumlahkan.</p>
      </Card>
      <Card title="Saldo pembuka">
        <p className="mb-2 text-xs text-slate-500">Shopee: usulan dari file (Saldo Akhir / Saldo Iklan). TikTok: isi manual dari saldo Seller Center pada tanggal saldo pembuka (file TikTok tidak punya saldo berjalan).</p>
        <div className="space-y-2">
          {rows.map((r, i) => {
            const cur = saved.get(`${r.s.id}|${r.ch}|${r.w}`);
            const su = sugg[i];
            const v = cur ? n(cur.amount) : su?.amount ?? 0;
            if (!r.acct) return null;
            return (
              <ActionForm key={`${r.s.id}${r.ch}${r.w}`} action={saveGlOpeningAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2 text-sm">
                <input type="hidden" name="storeId" value={r.s.id} /><input type="hidden" name="channel" value={r.ch} /><input type="hidden" name="wallet" value={r.w} />
                <input type="hidden" name="source" value={su && !cur ? "FILE" : cur?.source ?? "MANUAL"} />
                <div className="min-w-[14rem] flex-1"><b>{r.s.name} · {CH[r.ch as "SHP" | "TTS"]} · {r.w === "IKLAN" ? "Saldo iklan" : "Saldo penjual"}</b><div className="text-xs text-slate-500">{r.acct} {GL_ACCOUNTS[r.acct]?.name} {cur ? <Badge tone="green">tersimpan</Badge> : <Badge tone="amber">belum</Badge>}</div>{su && <div className="text-xs text-sky-700">Usulan file: {idr(su.amount)} — {su.note}</div>}</div>
                <Field label="Saldo"><input name="amount" inputMode="numeric" className="input w-40" defaultValue={v ? v.toLocaleString("id-ID") : ""} placeholder="0" /></Field>
                <Field label="Catatan"><input name="note" className="input w-44" defaultValue={cur?.note ?? ""} placeholder="mis. Seller Center per tanggal" /></Field>
                {canPost && <Submit className="btn-secondary" pendingText="…">Simpan</Submit>}
                <p className="basis-full text-xs text-slate-500">Jurnal bayangan: Dr {r.acct} · Cr 3-9000 Ekuitas Saldo Awal sebesar saldo (negatif = sebaliknya).</p>
              </ActionForm>
            );
          })}
        </div>
      </Card>
      <Card title="Neraca saldo bayangan">
        {tb.rows.length === 0 ? <Empty title="Belum ada jurnal bayangan" hint="Isi saldo pembuka atau tekan Bangun ulang." /> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>Kode</th><th>Akun</th><th className="num">Debit</th><th className="num">Kredit</th><th className="num">Saldo</th></tr></thead>
            <tbody>{tb.rows.map((x) => <tr key={x.code} className={x.code === "6-1640" && x.balance ? "bg-amber-50" : ""}><td className="font-mono text-xs">{x.code}</td><td>{x.name}</td><td className="num">{x.debit ? idr(x.debit) : ""}</td><td className="num">{x.credit ? idr(x.credit) : ""}</td><td className="num">{idr(x.balance)}</td></tr>)}</tbody>
            <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={2}>Total {tb.totalDebit === tb.totalCredit ? "✓ seimbang" : "✗ tidak seimbang"}</td><td className="num">{idr(tb.totalDebit)}</td><td className="num">{idr(tb.totalCredit)}</td><td /></tr></tfoot>
          </table></div>
        )}
      </Card>
      <Card title="Daftar periksa sebelum aktif nyata (1 Des 2026, hanya Owner)">
        <ul className="space-y-1 text-sm">{checks.map(([l, ok, d]) => <li key={l} className="flex gap-2"><span>{ok ? "✅" : "⬜"}</span><span>{l} <span className="text-xs text-slate-500">— {d}</span></span></li>)}</ul>
      </Card>
      <Card title="Jurnal bayangan terbaru">
        <div className="table-wrap"><Paged size={12}><table className="tbl">
          <thead><tr><th>Tanggal</th><th>Keterangan</th><th>Baris</th></tr></thead>
          <tbody>{journals.map((j) => <tr key={j.id}><td className="whitespace-nowrap">{fmtDate(j.date)}</td><td className="text-xs">{j.description}</td><td className="text-xs">{j.lines.map((l) => <div key={l.id} className="flex justify-between gap-3 font-mono"><span>{l.account} {GL_ACCOUNTS[l.account]?.name ?? ""}</span><span>{n(l.debit) ? `D ${idr(n(l.debit))}` : `K ${idr(n(l.credit))}`}</span></div>)}</td></tr>)}</tbody>
        </table></Paged></div>
      </Card>
    </div>
  );
}
