import { addDays, todayStr } from "@/lib/time";
import { CH_LABEL, KIND_LABEL, REQUIRED, bulanLabel, type Cell, type Matrix } from "@/lib/marketplace/kelengkapan";
import { Badge, Card, Field } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Modal } from "@/components/Modal";
import { ModalForm } from "@/components/ModalForm";
import { clearAccessGapAction, saveAccessGapAction } from "./actions";

const SHORT: Record<string, string> = { ORDER: "Psn", INCOME: "Hasil", BALANCE: "Saldo", ADSBILL: "Iklan" };
const TONE: Record<string, string> = { OK: "bg-emerald-50 text-emerald-800", PARTIAL: "bg-amber-50 text-amber-800", MISSING: "bg-rose-50 text-rose-800", WAIT: "bg-slate-100 text-slate-600", NA: "bg-slate-50 text-slate-400" };
const ICON: Record<string, string> = { OK: "✓", PARTIAL: "⚠", MISSING: "✗", WAIT: "⏸", NA: "·" };
const dd = (d: string | null) => (d ? d.slice(8) : "");
const title = (c: Cell) => ({ OK: `Lengkap sampai tanggal ${dd(c.through)}`, PARTIAL: `Sebagian bulan, baru sampai tanggal ${dd(c.through)}`, MISSING: "Belum ada", WAIT: c.note ?? "Menunggu akses", NA: "-" })[c.status];

/** Matriks kelengkapan data per bulan (toko × kanal × bulan × jenis file) + penandaan "akses belum tersedia". */
export function Kelengkapan({ m, canManage, stores, compact = false }: { m: Matrix; canManage: boolean; stores: { id: string; name: string }[]; compact?: boolean }) {
  const miss = m.missing.length;
  const waits = m.gaps.filter((g) => g.paused);
  const due = m.gaps.filter((g) => g.due);
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  const body = m.rows.length === 0 ? <p className="text-sm text-slate-500">Belum ada data. Unggah file di bawah; matriks muncul setelah ada file yang diimpor.</p> : (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">
        {m.start ? `Wajib sejak ${m.start} sampai kemarin (${m.through}).` : "Tanggal mulai belum diatur (Penjualan › Dashboard › pengaturan sinkron): matriks hanya informasi, pengingat belum aktif."} ✓ lengkap · ⚠ sebagian bulan · ✗ belum ada · ⏸ menunggu akses.
      </p>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Toko · kanal</th>{m.months.map((mo) => <th key={mo}>{bulanLabel(mo)}</th>)}</tr></thead>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r.storeId + r.channel}>
                <td className="whitespace-nowrap font-medium">{r.store} · {CH_LABEL[r.channel]}</td>
                {m.months.map((mo) => (
                  <td key={mo}>
                    <div className="flex flex-wrap gap-1">
                      {REQUIRED[r.channel].map((k) => {
                        const c = r.cells[mo]?.[k] ?? { status: "NA" as const, through: null };
                        return <span key={k} title={`${KIND_LABEL[k]}: ${title(c)}`} className={`rounded px-1.5 py-0.5 text-xs font-medium ${TONE[c.status]}`}>{ICON[c.status]} {SHORT[k]}{(c.status === "OK" || c.status === "PARTIAL") && c.through ? ` ${dd(c.through)}` : ""}</span>;
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!compact && <p className="text-xs text-slate-500">Psn = Pesanan · Hasil = Penghasilan · Saldo = Saldo Penjual (Shopee) · Iklan = Saldo Iklan (Shopee). Angka kecil = tanggal terakhir yang tercakup. Dibaca dari periode isi file, bukan nama file.</p>}
    </div>
  );
  return (
    <Card title={`Kelengkapan data per bulan${miss ? ` · ${miss} belum lengkap` : m.rows.length ? " · lengkap" : ""}`} actions={canManage && !compact ? (
      <Modal trigger="Tandai akses belum tersedia" triggerClass="btn-secondary btn-sm" title="Akses belum tersedia" subtitle="Jenis file ini tidak bisa diunduh untuk sementara (mis. akses Penghasilan Shopee belum diberikan)">
        <ModalForm action={saveAccessGapAction} className="grid gap-3">
          <Field label="Toko"><select name="storeId" className="input" required>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Kanal"><select name="channel" className="input" required><option value="SHP">Shopee</option><option value="TTS">TikTok</option></select></Field>
          <Field label="Jenis file"><select name="kind" className="input" required>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}{k === "BALANCE" || k === "ADSBILL" ? " (hanya Shopee)" : ""}</option>)}</select></Field>
          <Field label="Catatan"><input name="note" className="input" placeholder="mis. menunggu pemilik akun memberi akses Finance" /></Field>
          <Field label="Tinjau ulang pada" hint="Sebelum tanggal ini pengingat jenis ini dijeda. Sesudahnya ditagih lagi."><input type="date" name="reviewAt" className="input" defaultValue={addDays(todayStr(), 7)} min={addDays(todayStr(), 1)} required /></Field>
          <p className="text-xs text-amber-700">Piutang toko ini tetap diberi peringatan “tidak bisa divalidasi” selama Penghasilan belum ada, dan Cek Integritas menandainya ⚠ (bukan ✓).</p>
          <Submit>Simpan</Submit>
        </ModalForm>
      </Modal>
    ) : undefined}>
      {body}
      {(waits.length > 0 || due.length > 0) && (
        <ul className="mt-3 space-y-1 text-sm">
          {[...waits, ...due].map((g) => (
            <li key={g.storeId + g.channel + g.kind} className="flex flex-wrap items-center gap-2">
              <Badge tone={g.paused ? "gray" : "amber"}>{g.paused ? "Menunggu akses" : "Waktunya tinjau"}</Badge>
              <span>{sn.get(g.storeId)} · {CH_LABEL[g.channel]} · {KIND_LABEL[g.kind]} — tinjau {g.reviewAt}{g.note ? ` · ${g.note}` : ""}</span>
              {canManage && !compact && (
                <ActionForm action={clearAccessGapAction} className="inline">
                  <input type="hidden" name="storeId" value={g.storeId} /><input type="hidden" name="channel" value={g.channel} /><input type="hidden" name="kind" value={g.kind} />
                  <Submit className="btn-secondary btn-sm" pendingText="…">Akses sudah tersedia</Submit>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
