import { redirect } from "next/navigation";

/** Form transaksi baru kini berupa popup di menu Transaksi; tautan lama tetap berfungsi */
export default function BaruPage() {
  redirect("/finance?baru=1");
}
