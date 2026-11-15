/**
 * Pilihan form "Kirim Bahan": dikelompokkan per jenis pekerjaan borongan yang AKTIF (mis. Single Pack, Cat Giftbox,
 * Cat Plastik). Titik = titik aktif yang diatur menjalankan tugas itu; bahan = bahan resep tugas yang aktif
 * (setengah jadi diutamakan, bahan baku sebagai bahan pendukung).
 */
type Task = { id: string; name: string; active: boolean; inputs: { item: { id: string; name: string; unit: string; type: string; active: boolean } }[] };
type Point = { id: string; name: string; active: boolean; viaDriver: boolean };
export type KirimItem = { id: string; name: string; unit: string; setengahJadi: boolean; stock: number };
export type KirimGroup = { key: string; name: string; tasks: string[]; points: { id: string; name: string; viaDriver: boolean }[]; items: KirimItem[] };
/** Paket bahan titik (pengaturan titik, mis. background, klip, cat): dikirim sebagai bahan pendukung */
export type PointKits = Record<string, KirimItem[]>;
type KitItem = { id: string; name: string; unit: string; type: string; active: boolean };

/** Kata pembeda varian di nama tugas (series / warna) yang dibuang untuk nama kelompok */
const VARIANT_WORDS = new Set(["cowok", "cewek", "hewan", "transport", "transportasi", "mix", "biru", "merah", "kuning", "hijau", "putih", "hitam", "pink", "ungu", "oranye", "coklat"]);

export function taskGroupName(name: string) {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && VARIANT_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export function kirimGroups(tasks: Task[], points: Point[], cfg: Record<string, { tasks: string[]; kit?: string[] }>, stock: Map<string, number>): KirimGroup[] {
  const groups = new Map<string, Task[]>();
  for (const t of tasks.filter((x) => x.active)) {
    const g = taskGroupName(t.name);
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const out: KirimGroup[] = [];
  for (const [name, ts] of groups) {
    const ids = ts.map((t) => t.id);
    const pts = points.filter((p) => p.active && (!(cfg[p.id]?.tasks.length) || cfg[p.id].tasks.some((id) => ids.includes(id))));
    const items = new Map<string, KirimItem>();
    for (const t of ts) for (const { item } of t.inputs) {
      if (!item.active || items.has(item.id)) continue;
      items.set(item.id, { id: item.id, name: item.name, unit: item.unit, setengahJadi: item.type === "BARANG_DALAM_PROSES", stock: Math.round((stock.get(item.id) ?? 0) * 1000) / 1000 });
    }
    // Tugas tanpa resep bahan tetap tampil bila titiknya punya paket bahan (dikirim sebagai bahan pendukung)
    if (!pts.length || (!items.size && !pts.some((p) => cfg[p.id]?.kit?.length))) continue;
    const list = [...items.values()].sort((a, b) => Number(b.setengahJadi) - Number(a.setengahJadi) || a.name.localeCompare(b.name, "id"));
    out.push({ key: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, tasks: ts.map((t) => t.name), points: pts.map((p) => ({ id: p.id, name: p.name, viaDriver: p.viaDriver })), items: list });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "id"));
}

/** Paket bahan aktif per titik dari pengaturan titik */
export function pointKits(points: Point[], cfg: Record<string, { kit?: string[] }>, items: KitItem[], stock: Map<string, number>): PointKits {
  const byId = new Map(items.filter((i) => i.active).map((i) => [i.id, i]));
  return Object.fromEntries(
    points.filter((p) => p.active).map((p) => [
      p.id,
      (cfg[p.id]?.kit ?? []).map((id) => byId.get(id)).filter((i): i is KitItem => !!i).map((i) => ({ id: i.id, name: i.name, unit: i.unit, setengahJadi: i.type === "BARANG_DALAM_PROSES", stock: Math.round((stock.get(i.id) ?? 0) * 1000) / 1000 })),
    ]),
  );
}

/** Barang yang boleh dikirim ke tiap titik: bahan resep kelompok yang dijalankan titik itu + paket bahan titik */
export function allowedByPoint(groups: KirimGroup[], kits: PointKits = {}): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const g of groups) for (const p of g.points) {
    const s = m.get(p.id) ?? new Set<string>();
    for (const i of g.items) s.add(i.id);
    for (const i of kits[p.id] ?? []) s.add(i.id);
    m.set(p.id, s);
  }
  return m;
}
