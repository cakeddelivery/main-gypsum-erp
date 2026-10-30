"use client";
import { Modal } from "./Modal";

/** Tombol "Lihat" bukti: pratinjau di popup, bukan tab baru */
export function ProofPreview({ src, mime, title = "Bukti transfer" }: { src: string; mime?: string | null; title?: string }) {
  return (
    <Modal trigger="Lihat" triggerClass="btn-secondary btn-sm" title={title}>
      {mime === "application/pdf" ? (
        <iframe src={src} title={title} className="h-[65vh] w-full rounded-lg border border-slate-200" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={title} className="mx-auto max-h-[65vh] w-auto rounded-lg" />
      )}
    </Modal>
  );
}
