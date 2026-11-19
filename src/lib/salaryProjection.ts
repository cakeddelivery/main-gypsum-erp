/** Proyeksi gaji bulanan & simulasi bolos (murni, aman dipakai di komponen klien) */

const dim = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ann = (join: string, y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-${String(Math.min(Number(join.slice(8, 10)), dim(y, m))).padStart(2, "0")}`;
const shift = (y: number, m: number, by: number) => { const t = y * 12 + (m - 1) + by; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; };
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Potongan Alpa: gaji pokok ÷ 30 × hari, dibulatkan, tidak melebihi gaji pokok (sama dengan penggajian) */
export function alpaCut(baseSalary: number, alpaDays: number) {
  if (baseSalary <= 0 || alpaDays <= 0) return 0;
  return Math.min(baseSalary, Math.round((baseSalary / 30) * alpaDays));
}

export type RunningCycle = { start: string; end: string; payDate: string; daysLeft: number };

/** Siklus gaji yang sedang berjalan pada `today`: dari "ulang bulan" tanggal masuk; gajian H+offset setelah siklus berakhir */
export function runningCycle(joinDate: string, today: string, payOffsetDays = 7): RunningCycle {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  let start = ann(joinDate, y, m);
  if (start > today) { const p = shift(y, m, -1); start = ann(joinDate, p.y, p.m); }
  const sy = Number(start.slice(0, 4));
  const sm = Number(start.slice(5, 7));
  const n = shift(sy, sm, 1);
  const next = ann(joinDate, n.y, n.m);
  return { start, end: addDays(next, -1), payDate: addDays(next, payOffsetDays), daysLeft: Math.max(0, Math.round((new Date(`${next}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000)) };
}

export type ProjectionInput = { baseSalary: number; allowanceTotal: number; alpaSoFar: number };

/** Perkiraan diterima bila ditambah `extraAlpa` hari Alpa lagi di sisa periode */
export function projectSalary(i: ProjectionInput, extraAlpa = 0) {
  const days = i.alpaSoFar + Math.max(0, extraAlpa);
  const cut = alpaCut(i.baseSalary, days);
  return { alpaDays: days, cut, base: i.baseSalary - cut, total: i.baseSalary - cut + i.allowanceTotal, perDay: Math.round(i.baseSalary / 30) };
}
