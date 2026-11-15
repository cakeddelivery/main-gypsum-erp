/**
 * Pengelompokan karyawan di tabel Jadwal shift: per divisi, divisi produksi (punya laporan shift) dulu,
 * lalu Supervisor sebagai kelompok sendiri, lalu divisi lainnya. Di dalam kelompok urut nama.
 */
export type SchedEmp = { id: string; name: string; role?: string | null; division: { id: string; name: string; code: string; reportTemplate: string | null } };
export type SchedGroup<T> = { key: string; name: string; rows: T[] };

const SUPERVISOR_KEY = "__supervisor";

export function scheduleGroups<T extends SchedEmp>(emps: T[]): SchedGroup<T>[] {
  const map = new Map<string, SchedGroup<T> & { rank: number; sort: string }>();
  for (const e of emps) {
    const spv = e.role === "SUPERVISOR";
    const key = spv ? SUPERVISOR_KEY : e.division.id;
    if (!map.has(key)) {
      const rank = spv ? 1 : e.division.reportTemplate ? 0 : 2;
      map.set(key, { key, name: spv ? "Supervisor" : e.division.name, rows: [], rank, sort: spv ? "" : rank === 0 ? e.division.code : e.division.name });
    }
    map.get(key)!.rows.push(e);
  }
  return [...map.values()]
    .sort((a, b) => a.rank - b.rank || a.sort.localeCompare(b.sort, "id"))
    .map(({ key, name, rows }) => ({ key, name, rows: [...rows].sort((a, b) => a.name.localeCompare(b.name, "id")) }));
}
