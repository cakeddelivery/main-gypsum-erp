"use server";
import { action, str } from "@/lib/action";
import { refreshStandards, setStandard } from "@/lib/usageStandard";

/** Owner menetapkan standar manual atau mengembalikannya ke otomatis; hitung ulang standar otomatis */
export const simpanStandar = action(
  "material.manage",
  async (fd, user) => {
    const key = str(fd, "key");
    const mode = str(fd, "mode") === "MANUAL" ? "MANUAL" : "AUTO";
    const raw = String(fd.get("value") ?? "").trim().replace(/\./g, "").replace(",", ".");
    await setStandard(key, { mode, value: raw ? Number(raw) : null }, user);
    return mode === "MANUAL" ? "Standar manual disimpan" : "Standar kembali otomatis";
  },
  ["/laporan/standar"],
);

export const hitungUlangStandar = action(
  "material.manage",
  async () => {
    const rows = await refreshStandards();
    const ok = rows.filter((r) => r.value != null).length;
    return ok ? `Standar otomatis dihitung ulang (${ok} dari ${rows.length} cukup data)` : "Belum cukup data (minimal 10 laporan terkirim) untuk standar otomatis";
  },
  ["/laporan/standar"],
);
