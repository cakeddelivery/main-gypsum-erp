import { redirect } from "next/navigation";

/** Alamat lama: panduan pindah ke menu Panduan */
export default function OldPanduan() {
  redirect("/panduan");
}
