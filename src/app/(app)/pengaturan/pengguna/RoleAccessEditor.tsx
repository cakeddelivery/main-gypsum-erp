"use client";
import { useState } from "react";

export type AccessGroup = {
  key: string;
  label: string;
  perms: { p: string; label: string; sensitive: boolean; disabled: boolean }[];
  /** Izin yang dinyalakan saat menu ini dinyalakan (bawaan role untuk menu ini, atau izin minimal) */
  turnOn: string[];
};

/**
 * Satu layar hak akses per role: tiap menu punya saklar besar (menu tampil / tidak) dan bisa dibuka untuk melihat
 * tindakan di dalamnya (saklar kecil). Yang dikirim ke server hanya daftar izin (name="perm"), sama seperti dulu.
 */
export function RoleAccessEditor({ groups, initial, fieldRole }: { groups: AccessGroup[]; initial: string[]; fieldRole: boolean }) {
  const [on, setOn] = useState(() => new Set(initial));
  const start = new Set(initial);
  const toggle = (ps: string[], value: boolean) =>
    setOn((cur) => {
      const next = new Set(cur);
      for (const p of ps) (value ? next.add(p) : next.delete(p));
      return next;
    });
  return (
    <div className="space-y-2">
      {groups.map((g) => {
        const usable = g.perms.filter((x) => !x.disabled);
        const count = usable.filter((x) => on.has(x.p)).length;
        const menuOn = count > 0;
        const sensitive = g.perms.some((x) => x.sensitive);
        return (
          <details key={g.key} className="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={menuOn}
                aria-label={`Menu ${g.label}`}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => (e.target.checked ? toggle(g.turnOn.filter((p) => usable.some((x) => x.p === p)), true) : toggle(g.perms.map((x) => x.p), false))}
              />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{g.label}</span>
                {sensitive && <span className="ml-2 whitespace-nowrap rounded bg-rose-100 px-1.5 align-middle text-[10px] font-semibold uppercase text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">ada izin sensitif</span>}
                <span className={`block text-xs ${menuOn ? "text-emerald-700 dark:text-emerald-400" : "text-slate-400"}`}>{menuOn ? `Tampil · ${count} dari ${usable.length} tindakan boleh` : "Tidak tampil"}</span>
              </span>
              <span className="whitespace-nowrap text-xs text-brand-600">Rincian ▾</span>
            </summary>
            <div className="grid gap-1 border-t border-slate-100 px-3 py-2 sm:grid-cols-2 dark:border-slate-800">
              {g.perms.map((x) => (
                <label key={x.p} className={`flex items-center gap-2 py-0.5 text-sm ${x.disabled ? "text-slate-400" : ""}`}>
                  <input
                    type="checkbox"
                    name="perm"
                    value={x.p}
                    checked={on.has(x.p)}
                    disabled={x.disabled}
                    aria-label={x.label}
                    data-sensitive={fieldRole && x.sensitive ? "1" : undefined}
                    data-initial={start.has(x.p) ? "1" : "0"}
                    onChange={(e) => toggle([x.p], e.target.checked)}
                  />
                  {x.label}
                  {x.sensitive && <span className="rounded bg-rose-100 px-1.5 text-[10px] font-semibold uppercase text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">sensitif</span>}
                  {x.disabled && <span className="text-[10px]">(khusus role tertentu)</span>}
                </label>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
