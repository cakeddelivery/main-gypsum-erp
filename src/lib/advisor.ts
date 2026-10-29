import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import { ruleInsights, type Snapshot } from "./analytics";

const MODEL = process.env.ADVISOR_MODEL || "claude-opus-5-5";

export function advisorConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM = `Kamu adalah penasihat keuangan & strategi untuk UMKM "Main Gypsum" (produsen lukis gypsum, toko Main Gypsum & Dunia Lukis, jual di marketplace dan offline).
Rekening: Seabank untuk operasional, ShopeePay untuk simpanan kompensasi owner (2 owner). Ada pinjaman modal dan utang supplier bahan baku.
Jawab dalam Bahasa Indonesia yang lugas untuk pemilik usaha (bukan akuntan). Gunakan hanya angka dari data yang diberikan; jika data kurang, katakan.
Format: 1) Kondisi singkat (2-3 kalimat: tumbuh atau tidak, kas aman atau tidak). 2) 3-5 rekomendasi prioritas, masing-masing dengan alasan berbasis angka dan langkah konkret minggu ini. 3) Risiko yang perlu diwaspadai. Maksimal 350 kata, tanpa tabel.`;

/** Data ringkas (tanpa data pribadi karyawan) yang dikirim ke Claude */
export function advisorPayload(s: Snapshot) {
  return {
    tanggal: s.today,
    bulanan: s.series.map((m) => ({ bulan: m.key, pendapatan: m.revenue, hpp: m.cogs, beban: m.expenses, kompensasiOwner: m.ownerComp, labaBersih: m.net, kasMasuk: m.cashIn, kasKeluar: m.cashOut, saldoKasAkhir: m.cashEnd })),
    posisi: { kasTotal: s.cash, titipanKompensasiOwner: s.ownerHeld, tabunganCicilan: s.loanSaving, kasBebas: s.freeCash, utangSupplier: s.supplierDebt, pinjamanModal: s.loanDebt, utangLewatTempo: s.overdueAmount, piutang: s.receivables, kasbonKaryawan: s.advances, nilaiPersediaan: s.inventory },
    kewajiban30Hari: s.obligations,
    rataRata3Bulan: { kasMasuk: s.avgCashIn, kasKeluar: s.avgCashOut },
    proyeksiKas30Hari: s.projected30,
    runwayBulan: s.runwayMonths,
    temuanOtomatis: ruleInsights(s).map((i) => i.title),
  };
}

/** Minta saran strategis ke Claude; hasil terakhir disimpan di pengaturan agar tidak perlu diminta ulang */
export async function askAdvisor(s: Snapshot, question?: string | null) {
  if (!advisorConfigured()) throw new Error("ANTHROPIC_API_KEY belum diatur di server");
  const client = new Anthropic();
  const userText = `Data keuangan (IDR):\n${JSON.stringify(advisorPayload(s))}\n\n${question ? `Pertanyaan owner: ${question}` : "Berikan analisis dan saran strategis bulan ini."}`;
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [{ role: "user", content: userText }],
  });
  if (response.stop_reason === "refusal") throw new Error("Permintaan tidak dapat diproses oleh AI. Coba ubah pertanyaan.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  if (!text) throw new Error("AI tidak mengembalikan jawaban");
  const value = JSON.stringify({ at: new Date().toISOString(), question: question ?? null, text });
  await prisma.setting.upsert({ where: { key: "advisor_last" }, create: { key: "advisor_last", value }, update: { value } });
  return text;
}

export async function lastAdvice() {
  const s = await prisma.setting.findUnique({ where: { key: "advisor_last" } });
  if (!s) return null;
  try {
    return JSON.parse(s.value) as { at: string; question: string | null; text: string };
  } catch {
    return null;
  }
}
