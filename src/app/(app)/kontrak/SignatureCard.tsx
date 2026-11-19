"use client";
import { useState } from "react";
import { SignaturePad } from "./SignaturePad";
import { Submit } from "@/components/ActionForm";

/** Kanvas + persetujuan + tombol kirim (aktif setelah ada goresan & centang) */
export function SignatureCard() {
  const [ink, setInk] = useState(false);
  const [agree, setAgree] = useState(false);
  return (
    <>
      <SignaturePad onChange={setInk} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>Saya telah membaca dan menyetujui seluruh isi kontrak ini.</span>
      </label>
      <Submit disabled={!ink || !agree} className="btn-primary w-full">Tandatangani kontrak</Submit>
    </>
  );
}
