"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useI18n } from "@/context/i18n";

export default function ConfirmDialog({ open, title, message, confirmLabel, danger = false, onConfirm, onClose }) {
    const { t } = useI18n();
    return (
        <Dialog.Root
            open={open}
            onOpenChange={(o) => {
                if (!o) {
                    onClose();
                }
            }}
        >
            <Dialog.Portal>
                <Dialog.Backdrop className="fixed inset-0 bg-black/60 z-40" />
                <Dialog.Popup className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-card border border-border rounded p-5 shadow-xl w-72 space-y-3 focus:outline-none">
                    <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
                    <Dialog.Description className="text-sm text-muted-foreground">{message}</Dialog.Description>
                    <div className="flex justify-end gap-2 pt-1">
                        <Dialog.Close className="inline-flex items-center h-7 px-2.5 text-xs rounded border border-border bg-background hover:bg-muted transition-colors">
                            {t.actions.cancel}
                        </Dialog.Close>
                        <button
                            onClick={() => {
                                onConfirm();
                                onClose();
                            }}
                            className={`inline-flex items-center h-7 px-2.5 text-xs rounded border transition-colors font-medium ${
                                danger
                                    ? "border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20"
                                    : "border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                            }`}
                        >
                            {confirmLabel ?? t.actions.confirm}
                        </button>
                    </div>
                </Dialog.Popup>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
