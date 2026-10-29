import Link from "next/link";
import { prisma } from "@/lib/db";
import { addDays, jakartaDateTime, jakartaParts, todayStr } from "@/lib/time";
import { idr } from "@/lib/money";
import { Card, FilterBar, Field } from "@/components/ui";
import { Paged } from "@/components/Paged";
import { DocBar, DocSection, DocTable } from "@/components/DocSheet";

export type SP = Record<string, string | undefined>;

/** Rentang laporan (default: bulan berjalan WIB) + filter toko (kosong = konsolidasi) */
export function parseRange(sp: SP) {
  const p = jakartaParts();
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : `${p.year}-${String(p.month).padStart(2, "0")}-01`;
  const to = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : todayStr();
  return { from, to, start: jakartaDateTime(from, "00:00"), end: jakartaDateTime(addDays(to, 1), "00:00"), storeId: sp.store || null };
}

export async function ReportFilter({ sp, showFrom = true, extra }: { sp: SP; showFrom?: boolean; extra?: React.ReactNode }) {
  const r = parseRange(sp);
  const stores = await prisma.store.findMany({ orderBy: { code: "asc" } });
  return (
    <FilterBar>
      {showFrom && <Field label="Dari"><input type="date" name="from" defaultValue={r.from} className="input" /></Field>}
      <Field label={showFrom ? "Sampai" : "Per tanggal"}><input type="date" name="to" defaultValue={r.to} className="input" /></Field>
      <Field label="Toko">
        <select name="store" defaultValue={r.storeId ?? ""} className="input">
          <option value="">Konsolidasi (semua toko)</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      {extra}
    </FilterBar>
  );
}

export async function storeLabel(storeId: string | null) {
  if (!storeId) return "Konsolidasi Main Gypsum & Dunia Lukis";
  return (await prisma.store.findUnique({ where: { id: storeId } }))?.name ?? "-";
}

/** Tabel akun di layar (tanpa kop surat): kartu + tabel + baris total */
export function AccountTable({ title, rows, total, totalLabel }: { title: string; rows: { code: string; name: string; amount: number }[]; total: number; totalLabel: string }) {
  return (
    <Card title={title}>
      <div className="table-wrap">
        <Paged><table className="tbl">
          <thead><tr><th>Kode</th><th>Akun</th><th className="num">Jumlah</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={3} className="text-slate-400">Tidak ada saldo</td></tr>}
            {rows.map((r) => <tr key={r.code + r.name}><td className="font-mono text-xs">{r.code}</td><td>{r.name}</td><td className={`num ${r.amount < 0 ? "text-rose-600" : ""}`}>{idr(r.amount)}</td></tr>)}
          </tbody>
          <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={2}>{totalLabel}</td><td className="num">{idr(total)}</td></tr></tfoot>
        </table></Paged>
      </div>
    </Card>
  );
}

/** Bagian laporan keuangan bergaya dokumen (kop surat): tabel akun + baris total */
export function Section({ no, tone, title, hint, rows, total, totalLabel }: { no?: number; tone?: "blue" | "green" | "amber" | "red"; title: string; hint?: string; rows: { code: string; name: string; amount: number }[]; total: number; totalLabel: string }) {
  return (
    <DocSection no={no} tone={tone} title={title} hint={hint}>
      <DocTable head={<tr><th>Kode</th><th>Akun</th><th className="num">Jumlah (Rp)</th></tr>} empty={rows.length ? undefined : "Tidak ada saldo pada periode ini"}>
        {rows.map((r) => (
          <tr key={r.code + r.name}><td className="whitespace-nowrap">{r.code}</td><td>{r.name}</td><td className={`num ${r.amount < 0 ? "doc-neg" : ""}`}>{(r.amount < 0 ? "-" : "") + Math.abs(r.amount).toLocaleString("id-ID")}</td></tr>
        ))}
      </DocTable>
      <DocBar label={totalLabel} value={idr(total)} negative={total < 0} />
    </DocSection>
  );
}

/** Nama penanda tangan dari label toko ("Konsolidasi Main Gypsum & Dunia Lukis" → "Main Gypsum & Dunia Lukis") */
export const signerOf = (store: string) => store.replace(/^Konsolidasi /, "");

export const REPORTS = [
  { href: "/akuntansi/laba-rugi", label: "Laba rugi", desc: "Pendapatan, HPP, beban, laba bersih" },
  { href: "/akuntansi/neraca", label: "Neraca", desc: "Aset, kewajiban, ekuitas" },
  { href: "/akuntansi/arus-kas", label: "Arus kas", desc: "Operasi, investasi, pendanaan" },
  { href: "/akuntansi/jurnal", label: "Jurnal umum", desc: "Semua jurnal + jurnal manual" },
  { href: "/akuntansi/buku-besar", label: "Buku besar", desc: "Mutasi & saldo per akun/rekening" },
  { href: "/akuntansi/neraca-saldo", label: "Neraca saldo", desc: "Debit & kredit per akun" },
  { href: "/stok/kartu", label: "Kartu persediaan", desc: "Mutasi & nilai persediaan per item" },
  { href: "/akuntansi/piutang-utang", label: "Piutang & utang", desc: "Tagihan & kewajiban usaha" },
  { href: "/akuntansi/aset", label: "Aset tetap", desc: "Peralatan, cetakan, penyusutan" },
  { href: "/akuntansi/saldo-rekening", label: "Atur saldo rekening", desc: "Samakan saldo Seabank, ShopeePay, kas" },
  { href: "/akuntansi/saldo-awal", label: "Saldo awal & penyesuaian", desc: "Input saldo pembukaan" },
  { href: "/akuntansi/coa", label: "Chart of Accounts", desc: "Bagan akun manufaktur" },
  { href: "/akuntansi/tutup-buku", label: "Tutup buku", desc: "Penutupan periode bulanan" },
];
