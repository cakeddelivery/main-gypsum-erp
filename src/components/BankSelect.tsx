"use client";
import { useState } from "react";
import { BANK_OPTIONS, BANK_OTHER } from "@/lib/banks";

/** Pilih nama bank/e-wallet (dropdown bisa dicari); "Lainnya" = isi manual. Nilai akhir dikirim sebagai `name`. */
export function BankSelect({ name = "bankName", defaultValue, required }: { name?: string; defaultValue?: string | null; required?: boolean }) {
  const known = !defaultValue || (BANK_OPTIONS as readonly string[]).includes(defaultValue);
  const [choice, setChoice] = useState(defaultValue ? (known ? defaultValue : BANK_OTHER) : "");
  const [other, setOther] = useState(known ? "" : (defaultValue ?? ""));
  const value = choice === BANK_OTHER ? other.trim() : choice;
  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={value} />
      <select value={choice} onChange={(e) => setChoice(e.target.value)} className="input" required={required} aria-label="Nama bank">
        <option value="" disabled>— pilih bank / e-wallet —</option>
        <optgroup label="Bank">{BANK_OPTIONS.slice(0, 16).map((b) => <option key={b} value={b}>{b}</option>)}</optgroup>
        <optgroup label="E-wallet">{BANK_OPTIONS.slice(16).map((b) => <option key={b} value={b}>{b}</option>)}</optgroup>
        <option value={BANK_OTHER}>{BANK_OTHER} (isi manual)</option>
      </select>
      {choice === BANK_OTHER && <input value={other} onChange={(e) => setOther(e.target.value)} className="input" placeholder="Nama bank / e-wallet" required={required} maxLength={60} />}
    </div>
  );
}
