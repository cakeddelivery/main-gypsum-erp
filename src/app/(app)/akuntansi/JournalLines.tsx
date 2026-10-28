"use client";
import { useState } from "react";

type Acc = { id: string; code: string; name: string };

/** Baris jurnal dinamis dengan indikator keseimbangan */
export function JournalLines({ accounts, mode = "journal" }: { accounts: Acc[]; mode?: "journal" | "opening" }) {
  const [rows, setRows] = useState(() => Array.from({ length: mode === "journal" ? 2 : 4 }, (_, i) => ({ k: i, d: "", c: "" })));
  const num = (s: string) => Number(s.replace(/\./g, "")) || 0;
  const td = rows.reduce((s, r) => s + num(r.d), 0);
  const tc = rows.reduce((s, r) => s + num(r.c), 0);
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={r.k} className="grid grid-cols-12 gap-2">
          <select name="acc" className="input col-span-12 sm:col-span-5" defaultValue="">
            <option value="">— akun —</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
          {mode === "journal" ? (
            <>
              <input name="debit" inputMode="numeric" placeholder="Debit" className="input col-span-4 sm:col-span-2" value={r.d} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, d: e.target.value } : y)))} />
              <input name="credit" inputMode="numeric" placeholder="Kredit" className="input col-span-4 sm:col-span-2" value={r.c} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, c: e.target.value } : y)))} />
              <input name="memo" placeholder="Memo" className="input col-span-4 sm:col-span-3" />
            </>
          ) : (
            <input name="amount" inputMode="numeric" placeholder="Saldo (normal; negatif bila terbalik)" className="input col-span-12 sm:col-span-7" />
          )}
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((x) => [...x, { k: Date.now(), d: "", c: "" }])}>+ Baris</button>
        {mode === "journal" && <span className={`text-sm font-medium ${td === tc && td > 0 ? "text-emerald-600" : "text-rose-600"}`}>Debit {td.toLocaleString("id-ID")} · Kredit {tc.toLocaleString("id-ID")} {td === tc && td > 0 ? "✓ seimbang" : "— belum seimbang"}</span>}
      </div>
    </div>
  );
}
