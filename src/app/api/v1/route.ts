import { NextResponse } from "next/server";

/** Dokumentasi singkat Finance API v1 */
export async function GET() {
  return NextResponse.json({
    name: "Main Gypsum Finance API",
    version: "v1",
    auth: "Authorization: Bearer mgk_<prefix>_<secret> (dibuat Owner di Pengaturan → Telegram & Hermes)",
    rules: [
      "IDR-only (bilangan bulat rupiah), zona waktu Asia/Jakarta",
      "POST/PATCH wajib header Idempotency-Key (8-128 karakter)",
      "API hanya membuat/mengubah DRAFT. Pembukuan wajib dikonfirmasi manusia berwenang (web atau tombol Telegram)",
      "Tidak ada akses SQL/database langsung",
    ],
    endpoints: {
      "GET /api/v1/finance/accounts": "finance:read — daftar rekening",
      "GET /api/v1/finance/categories": "finance:read — daftar kategori",
      "POST /api/v1/finance/extract": "finance:read — {text} → hasil ekstraksi aturan (tanpa menyimpan)",
      "POST /api/v1/finance/drafts": "finance:draft — buat draft {telegram_user_id, direction, amount, date, account_code, to_account_code?, category_id?, store_code?, note?, raw_text?, telegram_chat_id?, proof_base64?, proof_mime?, ai_extraction?, notify?}",
      "GET /api/v1/finance/drafts?status=": "finance:read — daftar transaksi",
      "GET /api/v1/finance/drafts/:id": "finance:read — status draft",
      "PATCH /api/v1/finance/drafts/:id": "finance:draft — lengkapi/ubah draft yang belum dibukukan",
      "GET /api/v1/finance/summary?date=YYYY-MM-DD": "finance:read — rekap harian",
    },
  });
}
