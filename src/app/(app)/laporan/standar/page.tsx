import Link from "next/link";
import { requirePerm } from "@/lib/auth";
import { listStandards, MIN_SAMPLE, TOLERANCE_PCT, unmonitoredItems } from "@/lib/usageStandard";
import { Badge, Card, Empty, Field, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/ActionForm";
import { Paged } from "@/components/Paged";
import { hitungUlangStandar, simpanStandar } from "./actions";

export const metadata = { title: "Standar Pemakaian" };
const f = (n: number | null, unit = "") => (n == null ? "-" : `${Number(n.toFixed(2)).toLocaleString("id-ID")}${unit ? ` ${unit}` : ""}`);

/** Standar pemakaian proses (otomatis median 30 hari / manual Owner) + barang yang belum terpantau */
export default async function StandarPemakaian() {
  const user = await requirePerm("audit.view", "material.manage");
  const canEdit = user.can("material.manage");
  const [standards, unmonitored] = await Promise.all([listStandards(), unmonitoredItems()]);
  return (
    <div className="space-y-5">
      <PageHeader title="Standar pemakaian" subtitle={`Alert bila pemakaian melebihi standar ${TOLERANCE_PCT}% · hanya Owner yang menetapkan manual`} actions={<>{canEdit && <ActionForm action={hitungUlangStandar}><Submit className="btn-secondary" pendingText="Menghitung…">Hitung ulang otomatis</Submit></ActionForm>}<Link href="/laporan" className="btn-secondary">Kembali</Link></>} />
      <Card title="Standar proses">
        <p className="mb-3 text-xs text-slate-500">Otomatis = median 30 hari dari laporan shift terkirim (minimal {MIN_SAMPLE} laporan, nilai pencilan dibuang). Manual menimpa otomatis. 1 sak gypsum = 18 kg.</p>
        <div className="space-y-3">
          {standards.map((s) => (
            <div key={s.key} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-sm">{s.label}</b>
                <Badge tone={s.mode === "MANUAL" ? "amber" : "blue"}>{s.mode === "MANUAL" ? "Manual" : "Otomatis"}</Badge>
                {!s.enough && s.mode === "AUTO" && <Badge tone="gray">belum cukup data ({s.sample}/{MIN_SAMPLE})</Badge>}
              </div>
              <p className="mt-1 text-sm">Dipakai: <b>{f(s.effective, s.unit)}</b> · otomatis {f(s.auto, s.unit)} ({s.sample} laporan){s.manual != null && <> · manual {f(s.manual, s.unit)}</>}</p>
              {canEdit && (
                <ActionForm action={simpanStandar} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="key" value={s.key} />
                  <Field label={`Nilai manual (${s.unit})`} className="w-40"><input name="value" inputMode="decimal" defaultValue={s.manual ?? ""} className="input" /></Field>
                  <Submit className="btn-secondary btn-sm" name="mode" value="MANUAL">Tetapkan manual</Submit>
                  <Submit className="btn-secondary btn-sm" name="mode" value="AUTO">Kembali otomatis</Submit>
                </ActionForm>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card title="Bahan pendukung: standar = resep × hasil shift">
        <p className="text-sm text-slate-600">Dihitung otomatis di setiap laporan terkirim (kartu <b>Pemakaian vs standar</b> di detail laporan): hasil shift × resep BOM, dibandingkan pemakaian aktual dari stock opname (awal + masuk − sisa hitung). Bahan yang tidak dihitung sisanya tidak bisa dicek.</p>
      </Card>
      <Card title={`Belum terpantau (${unmonitored.length})`}>
        {!unmonitored.length ? <Empty title="Semua bahan aktif punya divisi dan dihitung di laporan 30 hari terakhir" /> : (
          <div className="table-wrap"><Paged>
            <table className="tbl">
              <thead><tr><th>Bahan</th><th>Divisi</th><th>Masalah</th></tr></thead>
              <tbody>{unmonitored.map((x) => <tr key={x.id}><td className="!whitespace-normal">{x.name}</td><td>{x.division ?? "-"}</td><td><Badge tone={x.reason === "TANPA_DIVISI" ? "red" : "amber"}>{x.reason === "TANPA_DIVISI" ? "tanpa divisi pemilik" : "tidak dihitung di laporan"}</Badge></td></tr>)}</tbody>
            </table>
          </Paged></div>
        )}
      </Card>
    </div>
  );
}
