import { describe, expect, it } from "vitest";
import { scheduleGroups } from "@/lib/scheduleGroups";

const div = (id: string, name: string, code: string, reportTemplate: string | null) => ({ id, name, code, reportTemplate });
const PACK = div("p", "Packing", "PCK", "PACKING");
const CETAK = div("c", "Cetak", "CTK", "CETAK");
const KANTOR = div("k", "Kantor", "KTR", null);

describe("Jadwal shift: kelompok per divisi", () => {
  it("divisi produksi dulu (urut kode), lalu Supervisor, lalu divisi lain; nama urut dalam kelompok", () => {
    const g = scheduleGroups([
      { id: "1", name: "Zaki", division: PACK },
      { id: "2", name: "Ani", division: KANTOR },
      { id: "3", name: "Budi", division: CETAK },
      { id: "4", name: "Sari", role: "SUPERVISOR", division: PACK },
      { id: "5", name: "Ayu", division: PACK },
      { id: "6", name: "Dodi", role: "OPERATOR", division: CETAK },
    ]);
    expect(g.map((x) => x.name)).toEqual(["Cetak", "Packing", "Supervisor", "Kantor"]);
    expect(g.map((x) => x.rows.map((r) => r.name))).toEqual([["Budi", "Dodi"], ["Ayu", "Zaki"], ["Sari"], ["Ani"]]);
  });

  it("tanpa Supervisor → tidak ada kelompok Supervisor kosong", () => {
    expect(scheduleGroups([{ id: "1", name: "A", division: CETAK }]).map((x) => x.name)).toEqual(["Cetak"]);
  });
});
