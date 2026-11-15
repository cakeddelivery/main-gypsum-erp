import { initials } from "@/lib/initials";

/** Foto profil bulat; bila belum ada foto tampil inisial nama */
export function Avatar({ name, src, size = 40, className = "" }: { name: string; src?: string | null; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) };
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={`Foto ${name}`} width={size} height={size} style={style} className={`shrink-0 rounded-full object-cover ring-1 ring-slate-200 ${className}`} loading="lazy" />
  ) : (
    <span aria-hidden style={style} className={`grid shrink-0 place-items-center rounded-full bg-brand-600 font-bold text-white ${className}`}>{initials(name)}</span>
  );
}
