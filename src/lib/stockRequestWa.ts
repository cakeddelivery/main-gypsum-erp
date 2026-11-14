import { fmtDate } from "./time";

/** Data minimum satu permintaan stok untuk dibagikan lewat WhatsApp */
export type WaRequest = {
  qty: number;
  note: string | null;
  division: { name: string };
  item: { name: string; unit: string; buyMode: "ONLINE" | "OFFLINE"; productUrl: string | null; supplier: { name: string } | null };
};

const num = (v: number) => v.toLocaleString("id-ID", { maximumFractionDigits: 3 });

/** "stok 1, limit 2" dari catatan permintaan otomatis laporan shift ("… = 1 roll, limit 2") */
export function stockHint(note: string | null): string | null {
  const m = note?.match(/=\s*([\d.,-]+)\s*[^,]*,\s*limit\s*([\d.,]+)/i);
  return m ? `stok ${m[1]}, limit ${m[2]}` : null;
}

/**
 * Teks WhatsApp siap kirim: dikelompokkan per divisi, tiap item dengan jumlah, stok/limit (bila ada),
 * dan cara beli (Online + link produk, atau Offline + supplier).
 */
export function requestWaText(reqs: WaRequest[], now: Date = new Date()): string {
  const byDiv = new Map<string, WaRequest[]>();
  for (const r of reqs) byDiv.set(r.division.name, [...(byDiv.get(r.division.name) ?? []), r]);
  const out = [`*Permintaan Stok — ${fmtDate(now)}*`];
  for (const [div, list] of [...byDiv].sort((a, b) => a[0].localeCompare(b[0], "id"))) {
    out.push("", `*${/^divisi\b/i.test(div) ? div : `Divisi ${div}`}*`);
    list.forEach((r, i) => {
      const hint = stockHint(r.note);
      out.push(`${i + 1}. ${r.item.name} — ${num(r.qty)} ${r.item.unit}${hint ? ` (${hint})` : ""}`);
      if (r.item.buyMode === "ONLINE") out.push(`   Online${r.item.productUrl ? `: ${r.item.productUrl}` : ""}`);
      else out.push(`   Offline${r.item.supplier ? ` · ${r.item.supplier.name}` : ""}`);
    });
  }
  return out.join("\n");
}

/** Link bagikan WhatsApp: pengguna memilih sendiri chat/grup tujuannya (tanpa API berbayar) */
export function waShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
