"use client";
import { useEffect } from "react";

/**
 * Umpan balik isian untuk SEMUA form (dipasang sekali di Shell):
 * - Kolom yang belum benar (wajib diisi, angka di luar batas, dll.) diberi garis merah, bergetar pelan,
 *   dan pesan muncul halus di bawahnya — menggantikan gelembung bawaan browser yang mudah terlewat di HP.
 * - Layar otomatis menggulir ke kolom PERTAMA yang salah lalu fokus ke sana.
 * - Pesan hilang sendiri begitu kolom diperbaiki.
 * - Di HP, kolom yang disentuh digulir ke tengah agar tidak tertutup keyboard.
 */

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Putar ulang animasi getar pada elemen */
export function shake(el: Element) {
  el.classList.remove("anim-shake");
  void (el as HTMLElement).offsetWidth; // paksa reflow agar animasi bisa diulang
  el.classList.add("anim-shake");
}

/** Gulir elemen ke tengah area yang terlihat (popup atau halaman), opsional fokus */
export function revealField(el: HTMLElement, focus = true) {
  el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
  if (focus) el.focus({ preventScroll: true });
}

/** Elemen yang benar-benar terlihat untuk sebuah kolom: tombol pengganti dropdown (ChoiceEnhancer) atau kolom itu sendiri */
function visibleTarget(el: HTMLElement): HTMLElement {
  if (el.classList.contains("choice-native")) {
    const host = el.nextElementSibling as HTMLElement | null;
    if (host?.matches(".choice-seg, .choice-search")) return host;
  }
  return el;
}

function focusTarget(el: HTMLElement): HTMLElement {
  const t = visibleTarget(el);
  if (t === el) return el;
  return t.querySelector<HTMLElement>(".choice-trigger, button.choice-on, button") ?? t;
}

/** Tempat pesan: setelah kolom, atau setelah pembungkus dropdown/label kotak centang */
function messageAnchor(el: HTMLElement): HTMLElement {
  const t = visibleTarget(el);
  if (t !== el) return t;
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.closest("label") ?? el;
  return el;
}

function messageFor(el: HTMLElement & { validity: ValidityState; validationMessage: string }) {
  const v = el.validity;
  if (v.valueMissing) {
    if (el instanceof HTMLSelectElement) return "Pilih salah satu dulu";
    if (el instanceof HTMLInputElement && el.type === "file") return "Lampirkan file dulu";
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return "Wajib dicentang/dipilih";
    return "Wajib diisi";
  }
  return el.validationMessage || "Isian belum benar";
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function clear(el: Field) {
  el.removeAttribute("aria-invalid");
  visibleTarget(el).classList.remove("field-invalid", "anim-shake");
  const id = el.getAttribute("data-err-id");
  if (id) document.getElementById(id)?.remove();
  el.removeAttribute("data-err-id");
}

let seq = 0;

export function FormFeedback() {
  useEffect(() => {
    // Satu kali kirim memicu banyak event "invalid"; hanya yang pertama digulir & difokus
    let firstDone = false;
    let reset: number | undefined;

    const onInvalid = (e: Event) => {
      const el = e.target as Field;
      if (!el?.form) return;
      e.preventDefault(); // ganti gelembung bawaan browser dengan pesan di bawah kolom
      const target = visibleTarget(el);
      el.setAttribute("aria-invalid", "true");
      target.classList.add("field-invalid");
      shake(target);

      const text = messageFor(el);
      let msg = el.getAttribute("data-err-id") ? document.getElementById(el.getAttribute("data-err-id")!) : null;
      if (!msg) {
        msg = document.createElement("span");
        msg.id = `fe-${++seq}`;
        msg.className = "field-error";
        msg.setAttribute("role", "alert");
        messageAnchor(el).after(msg);
        el.setAttribute("data-err-id", msg.id);
        el.setAttribute("aria-describedby", [el.getAttribute("aria-describedby"), msg.id].filter(Boolean).join(" "));
      }
      msg.textContent = text;

      if (!firstDone) {
        firstDone = true;
        revealField(focusTarget(el));
      }
      window.clearTimeout(reset);
      reset = window.setTimeout(() => (firstDone = false), 0);
    };

    const onFix = (e: Event) => {
      const el = e.target as Field;
      if (!el?.hasAttribute?.("aria-invalid")) return;
      if (el.validity.valid) clear(el);
    };

    // Formulir dikosongkan (reset) → pesan lama ikut hilang
    const onReset = (e: Event) => {
      (e.target as HTMLFormElement).querySelectorAll<Field>("[aria-invalid]").forEach(clear);
    };

    // HP: kolom yang difokus digulir ke tengah setelah keyboard muncul, agar tidak tertutup keyboard
    let focusTimer: number | undefined;
    const onFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (!el.matches?.("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea")) return;
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (document.activeElement !== el) return;
        const vv = window.visualViewport;
        const bottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
        const r = el.getBoundingClientRect();
        if (r.bottom > bottom - 16 || r.top < 56) el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
      }, 350);
    };

    document.addEventListener("invalid", onInvalid, true);
    document.addEventListener("input", onFix, true);
    document.addEventListener("change", onFix, true);
    document.addEventListener("reset", onReset, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("invalid", onInvalid, true);
      document.removeEventListener("input", onFix, true);
      document.removeEventListener("change", onFix, true);
      document.removeEventListener("reset", onReset, true);
      document.removeEventListener("focusin", onFocus);
    };
  }, []);
  return null;
}
