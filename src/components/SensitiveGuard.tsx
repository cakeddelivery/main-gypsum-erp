"use client";
import { useEffect, useRef } from "react";

/**
 * Pengaman izin sensitif di form hak akses. Kotak centang bertanda data-sensitive="1" (izin keuangan/gaji/pengaturan
 * untuk role lapangan) yang BARU dicentang memunculkan konfirmasi sebelum form dikirim. Bila disetujui, field tersembunyi
 * confirmSensitive=on ikut terkirim (server tetap menolak tanpa itu). Konfirmasi di layar dipakai karena form dikosongkan
 * React setelah server menolak, sehingga centangan Owner akan hilang bila baru diperingatkan dari server.
 */
export function SensitiveGuard() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      const boxes = [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-sensitive="1"]')].filter((b) => b.checked && !b.defaultChecked);
      if (!boxes.length) { ref.current!.value = ""; return; }
      const names = boxes.map((b) => b.getAttribute("aria-label") || b.closest("label")?.textContent?.trim() || b.value).slice(0, 8);
      if (window.confirm(`Izin SENSITIF (keuangan, gaji, pengaturan) akan diberikan ke role lapangan:\n\n• ${names.join("\n• ")}\n\nRole lapangan (Operator, Kapten, Supervisor, Koordinator, PIC Content) biasanya tidak boleh melihat data ini. Lanjutkan?`)) {
        ref.current!.value = "on";
      } else {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    form.addEventListener("submit", onSubmit, { capture: true });
    return () => form.removeEventListener("submit", onSubmit, { capture: true });
  }, []);
  return <input ref={ref} type="hidden" name="confirmSensitive" defaultValue="" />;
}
