"use client";
import { useState } from "react";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/** Isian password dengan tombol mata (tampilkan/sembunyikan). */
export function PasswordInput({ className = "input", ...rest }: Props) {
  const [show, setShow] = useState(false);
  const label = show ? "Sembunyikan password" : "Tampilkan password";
  return (
    <div className="relative">
      <input {...rest} type={show ? "text" : "password"} className={`${className} pr-11`} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={label}
        aria-pressed={show}
        title={label}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-slate-500 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden>
          {show ? (
            <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 19 12 19a9.6 9.6 0 0 0 5.4-1.6" />
          ) : (
            <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          )}
        </svg>
      </button>
    </div>
  );
}
