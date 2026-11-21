import { CH_LABEL, incomeGapStores } from "@/lib/marketplace/kelengkapan";

/** Peringatan di kartu Piutang: toko × kanal yang data Penghasilannya belum ada (akses belum tersedia) → Piutang tidak bisa divalidasi */
export async function PiutangWarning({ stores, storeId, channel }: { stores: { id: string; name: string }[]; storeId?: string; channel?: string }) {
  const gaps = (await incomeGapStores()).filter((g) => (!storeId || g.storeId === storeId) && (!channel || g.channel === channel));
  if (!gaps.length) return null;
  const sn = new Map(stores.map((s) => [s.id, s.name]));
  return (
    <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <b>Piutang tidak bisa divalidasi: data penghasilan belum ada.</b>{" "}
      {gaps.map((g) => `${CH_LABEL[g.channel]} ${sn.get(g.storeId) ?? ""} (${g.paused ? `menunggu akses, tinjau ${g.reviewAt}` : "akses perlu ditinjau"})`).join("; ")}. Angka Piutang untuk toko ini hanya perkiraan dari file pesanan.
    </div>
  );
}
