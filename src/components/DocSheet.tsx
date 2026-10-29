import type { Letterhead } from "@/lib/letterhead";
import { todayStr } from "@/lib/time";

/** "2026-10-01" → "01 Oktober 2026" */
export function fmtLong(d: string | Date): string {
  const x = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
  return x.toLocaleDateString("id-ID", { timeZone: "UTC", day: "2-digit", month: "long", year: "numeric" });
}
export const fmtRange = (from: string, to: string) => (from === to ? fmtLong(from) : `${fmtLong(from)} – ${fmtLong(to)}`);

const I = {
  pin: <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Zm0-9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z" fill="currentColor" />,
  wa: <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8 0-1.3.7-2 1-2.3.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.3.5-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3Z" fill="#25d366" />,
  cal: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><path d="M7.5 13.5h2v2h-2zM11 13.5h2v2h-2zM14.5 13.5h2v2h-2zM7.5 17h2v2h-2zM11 17h2v2h-2z" fill="currentColor" /></>,
  coins: <><ellipse cx="12" cy="6" rx="7" ry="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M5 6v4c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 10v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4M5 14v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4" fill="none" stroke="currentColor" strokeWidth="2" /></>,
};
export const DocIcon = ({ name, size = 22 }: { name: keyof typeof I; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>{I[name]}</svg>
);

/**
 * Wadah tersembunyi untuk versi dokumen ber-kop surat. Halaman tetap menampilkan tabel biasa;
 * versi ini hanya dipakai DownloadJpg (disalin, digambar, lalu dipratinjau sebelum diunduh).
 */
export function DocExport({ children }: { children: React.ReactNode }) {
  return <div hidden aria-hidden>{children}</div>;
}

/**
 * Dokumen siap unduh JPG dengan kop surat Main Gypsum yang seragam (laporan, slip, rekap, dll).
 * Isi dokumen bebas; gunakan DocSection / DocBar / DocSummary agar tampilannya konsisten.
 * Tampil terang juga di mode malam. Saat diunduh, dokumen digambar ulang selebar `exportWidth` (lihat DownloadJpg).
 */
export function DocSheet({
  id, lh, eyebrow, title, subtitle, meta, notes = [], signer = "Manajemen", signerOrg, signDate, exportWidth = 1000, children,
}: {
  id: string;
  lh: Letterhead;
  eyebrow: string;
  title: string;
  subtitle?: React.ReactNode;
  /** Kotak kanan atas, mis. { label: "Periode Laporan", value: "01 Oktober 2026 – 29 Oktober 2026" } */
  meta?: { label: string; value: React.ReactNode };
  notes?: React.ReactNode[];
  signer?: string;
  signerOrg?: string;
  signDate?: string;
  exportWidth?: number;
  children: React.ReactNode;
}) {
  return (
    <div id={id} data-export-width={exportWidth} className="doc theme-light">
      <svg className="doc-wave doc-wave-top" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden>
        <path d="M120 0C170 40 210 70 280 80c60 9 90 50 120 120V0Z" fill="#dbeafe" />
        <path d="M230 0c20 30 50 45 95 50 40 5 60 30 75 60V0Z" fill="#93c5fd" opacity=".55" />
        <path d="M310 0c10 18 30 28 55 30 18 2 28 12 35 25V0Z" fill="#3b82f6" opacity=".55" />
      </svg>
      <svg className="doc-wave doc-wave-bottom" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden>
        <path d="M0 30C150 0 300 50 500 30S850 0 1000 20v40H0Z" fill="#dbeafe" />
        <path d="M0 45c200-25 380 15 560 0s320-25 440-5v20H0Z" fill="#3b82f6" opacity=".55" />
      </svg>

      <header className="doc-kop">
        <div className="doc-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-kop.png" alt="" className="doc-logo" />
          <div>
            <div className="doc-brand-name">{lh.name}</div>
            <div className="doc-brand-tag">{lh.tagline}</div>
          </div>
        </div>
        <div className="doc-contact">
          <div><DocIcon name="pin" size={20} /><span>{lh.address}</span></div>
          <div><DocIcon name="wa" size={20} /><span>{lh.phone}</span></div>
        </div>
      </header>
      <hr className="doc-rule" />

      <div className="doc-head">
        <div className="min-w-0">
          <div className="doc-eyebrow">{eyebrow}</div>
          <h2 className="doc-title">{title}</h2>
          {subtitle && <div className="doc-subtitle">{subtitle}</div>}
        </div>
        {meta && (
          <div className="doc-meta">
            <DocIcon name="cal" size={34} />
            <div><div className="doc-meta-label">{meta.label}</div><div className="doc-meta-value">{meta.value}</div></div>
          </div>
        )}
      </div>

      <div className="doc-body">{children}</div>

      <footer className="doc-foot">
        <div className="doc-notes">
          {notes.length > 0 && (<><div className="doc-notes-title">Catatan:</div><ol>{notes.map((n, i) => <li key={i}>{n}</li>)}</ol></>)}
        </div>
        <div className="doc-sign">
          <div>{lh.city}, {fmtLong(signDate ?? todayStr())}</div>
          <div className="doc-sign-line" />
          <div className="doc-sign-name">{signer}</div>
          <div>{signerOrg ?? lh.name}</div>
        </div>
      </footer>
    </div>
  );
}

type Tone = "blue" | "green" | "amber" | "red";

/** Bagian bernomor: badge angka, judul kapital, keterangan */
export function DocSection({ no, tone = "blue", title, hint, children }: { no?: number | string; tone?: Tone; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <section className="doc-section">
      <div className="doc-sec-head">
        {no != null && <span className={`doc-num doc-${tone}`}>{no}</span>}
        <div><div className="doc-sec-title">{title}</div>{hint && <div className="doc-sec-hint">{hint}</div>}</div>
      </div>
      {children}
    </section>
  );
}

/** Baris total berlatar lembut, mis. "Kas bersih aktivitas operasi … Rp 0" */
export function DocBar({ label, note, value, tone = "blue", negative }: { label: React.ReactNode; note?: React.ReactNode; value: React.ReactNode; tone?: Tone; negative?: boolean }) {
  return (
    <div className={`doc-bar doc-bar-${tone}`}>
      <span className="doc-bar-label">{label}</span>
      {note && <span className="doc-bar-note">{note}</span>}
      <span className={`doc-bar-value ${negative ? "doc-neg" : ""}`}>{value}</span>
    </div>
  );
}

/** Kotak ringkasan akhir dengan ikon */
export function DocSummary({ rows }: { rows: { label: string; hint?: string; value: React.ReactNode; negative?: boolean; strong?: boolean }[] }) {
  return (
    <div className="doc-summary">
      <span className="doc-summary-icon"><DocIcon name="coins" size={30} /></span>
      <div className="doc-summary-rows">
        {rows.map((r, i) => (
          <div key={i} className="doc-summary-row">
            <div><div className="doc-summary-label">{r.label}</div>{r.hint && <div className="doc-summary-hint">{r.hint}</div>}</div>
            <div className={`doc-summary-value ${r.strong ? "doc-summary-strong" : ""} ${r.negative ? "doc-summary-neg" : ""}`}>{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tabel dokumen (tetap bisa digeser di HP) */
export function DocTable({ head, children, empty }: { head: React.ReactNode; children?: React.ReactNode; empty?: string }) {
  return (
    <div className="doc-table">
      <table>
        <thead>{head}</thead>
        <tbody>{children}{empty && <tr><td colSpan={99} className="doc-empty">{empty}</td></tr>}</tbody>
      </table>
    </div>
  );
}
