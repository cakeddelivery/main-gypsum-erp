import { redirect } from "next/navigation";

/** Form transaksi baru kini berupa popup di Finance Inbox; tautan lama tetap berfungsi */
export default function BaruPage() {
  redirect("/finance?baru=1");
}
