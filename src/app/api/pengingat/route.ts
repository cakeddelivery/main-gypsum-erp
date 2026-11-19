import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { dueReminders } from "@/lib/shiftReminders";

export const dynamic = "force-dynamic";

/** Pengingat yang berlaku sekarang untuk karyawan yang sedang membuka aplikasi (popup absen masuk / kirim laporan) */
export async function GET() {
  const user = await getUser();
  if (!user?.employeeId) return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  const items = (await dueReminders(new Date(), user.employeeId)).map(({ kind, key, title, body, url }) => ({ kind, key, title, body, url }));
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
