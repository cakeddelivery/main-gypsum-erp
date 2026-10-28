"use client";
import { ActionForm } from "./ActionForm";
import { useCloseModal } from "./Modal";
import type { ActionResult } from "@/lib/action";

/** ActionForm yang menutup modal setelah sukses */
export function ModalForm(props: { action: (p: ActionResult | null, fd: FormData) => Promise<ActionResult>; children: React.ReactNode; className?: string }) {
  const close = useCloseModal();
  return <ActionForm {...props} onSuccess={() => setTimeout(close, 700)} />;
}
