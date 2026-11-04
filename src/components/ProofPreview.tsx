"use client";
import { Modal } from "./Modal";

/**
 * Bukti transfer: pratinjau di popup, bukan tab baru.
 * Default tombol "Lihat"; `thumb` menampilkan gambar kecil yang bisa diklik untuk membuka popup.
 */
export function ProofPreview({ src, mime, title = "Bukti transfer", thumb, thumbClass = "max-h-80 w-full object-contain" }: { src: string; mime?: string | null; title?: string; thumb?: boolean; thumbClass?: string }) {
  const pdf = mime === "application/pdf";
  const trigger = thumb ? (
    pdf ? (
      <span className="link text-sm">Lihat PDF bukti</span>
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={title} className={`${thumbClass} cursor-zoom-in rounded-lg`} />
    )
  ) : (
    "Lihat"
  );
  return (
    <Modal trigger={trigger} triggerClass={thumb ? (thumbClass.includes("w-full") ? "block w-full" : "block shrink-0") : "btn-secondary btn-sm"} title={title} wide>
      {pdf ? (
        <iframe src={src} title={title} className="h-[70vh] w-full rounded-lg border border-slate-200" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={title} className="mx-auto max-h-[70vh] w-auto rounded-lg" />
      )}
      <p className="mt-3 text-center text-xs">
        <a className="link" href={src} download>
          Unduh file
        </a>
      </p>
    </Modal>
  );
}
