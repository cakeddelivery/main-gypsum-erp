import type { Termination } from "@prisma/client";
import { DocBar, DocSection, DocSheet, DocTable, fmtLong } from "@/components/DocSheet";
import type { Letterhead } from "@/lib/letterhead";
import { TERMINATION_REASONS, type Line, type TerminationReason } from "@/lib/terminationCalc";
import { idr } from "@/lib/money";
import { dateStr } from "@/lib/time";

type Calc = { lines: Line[]; net: number; warnings: string[]; contractNumber: string; contractStart: string; contractEnd: string; employeeName: string };

/** Surat Pengakhiran Hubungan Kerja + slip akhir (tema terang, ber-kop). QR = verifikasi HRD bila sudah diterbitkan. */
export function TerminationDoc({ t, lh, hrdName, qr, division, id = "pengakhiran" }: { t: Termination; lh: Letterhead; hrdName: string; qr: string | null; division: string; id?: string }) {
  const c = t.calc as unknown as Calc;
  const reason = TERMINATION_REASONS[t.reason as TerminationReason];
  return (
    <DocSheet
      id={id}
      lh={lh}
      eyebrow="Surat pengakhiran hubungan kerja"
      title={t.number}
      subtitle={<>Kepada: <b>{c.employeeName}</b> · {division}</>}
      meta={{ label: "Berlaku efektif", value: fmtLong(dateStr(t.effectiveDate)) }}
      notes={[...(t.note ? [t.note] : []), ...c.warnings, t.status === "BATAL" ? "Surat ini dibatalkan." : "Rincian di bawah adalah slip akhir; kompensasi dan ganti rugi hanya berlaku pada pengakhiran kontrak."]}
      signer={t.issuedBy ?? hrdName}
      signerOrg={`HRD ${lh.name}`}
      signDate={t.issuedAt ? dateStr(t.issuedAt) : undefined}
    >
      <DocSection title="Pernyataan" hint={`Perjanjian Kerja Waktu Tertentu Nomor ${c.contractNumber}`}>
        <p style={{ fontSize: 14, lineHeight: 1.6 }}>
          Dengan ini {lh.name} menyatakan bahwa hubungan kerja dengan <b>{c.employeeName}</b> berdasarkan perjanjian nomor {c.contractNumber} ({fmtLong(c.contractStart)} – {fmtLong(c.contractEnd)}) berakhir efektif pada <b>{fmtLong(dateStr(t.effectiveDate))}</b> karena <b>{reason.toLowerCase()}</b>.
        </p>
      </DocSection>
      <DocSection title="Slip akhir" hint="Upah dan hak yang diselesaikan">
        <DocTable head={<tr><th>Komponen</th><th className="num">Nilai</th></tr>}>
          {c.lines.map((l) => (
            <tr key={l.key}>
              <td>{l.label}{l.note && <div style={{ fontSize: 11, color: "#64748b" }}>{l.note}</div>}</td>
              <td className="num">{l.kind === "minus" ? `−${idr(l.amount)}` : l.kind === "info" ? <i>{idr(l.amount)}</i> : idr(l.amount)}</td>
            </tr>
          ))}
        </DocTable>
        <DocBar label="Total dibayarkan" value={idr(c.net)} tone="green" />
      </DocSection>
      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 8 }}>
        {qr ? <div style={{ textAlign: "center", fontSize: 11 }}><div dangerouslySetInnerHTML={{ __html: qr }} /><div>Pindai untuk verifikasi · {t.verifyCode}</div></div> : <span style={{ fontSize: 12, color: "#94a3b8" }}>Draf: belum ditandatangani HRD</span>}
      </div>
    </DocSheet>
  );
}
