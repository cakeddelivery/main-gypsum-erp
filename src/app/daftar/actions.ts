"use server";
import { redirect } from "next/navigation";
import { clientIp } from "@/lib/auth";
import { friendly, type ActionResult } from "@/lib/action";
import { submitRegistration } from "@/lib/registration";

const f = (fd: FormData, k: string) => String(fd.get(k) ?? "");

/** Form pendaftaran karyawan (halaman publik, butuh kode undangan) */
export async function registerAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  // Honeypot: kolom tersembunyi yang hanya diisi bot → pura-pura berhasil
  if (f(fd, "website")) redirect("/daftar/selesai");
  let number: string;
  try {
    if (f(fd, "password") !== f(fd, "confirm")) throw new Error("Konfirmasi password tidak sama");
    const r = await submitRegistration(
      f(fd, "kode"),
      {
        fullName: f(fd, "fullName"), nickname: f(fd, "nickname"), birthPlace: f(fd, "birthPlace"), birthDate: f(fd, "birthDate"), address: f(fd, "address"),
        phone: f(fd, "phone"), email: f(fd, "email"), username: f(fd, "username"), password: f(fd, "password"), gender: f(fd, "gender") as "L" | "P",
        startDate: f(fd, "startDate"), seabankNo: f(fd, "seabankNo"), seabankName: f(fd, "seabankName"),
      },
      await clientIp(),
    );
    number = r.number;
  } catch (e) {
    return { ok: false, error: friendly(e), ts: Date.now() };
  }
  redirect(`/daftar/selesai?no=${encodeURIComponent(number)}`);
}
