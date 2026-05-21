import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";

export interface AlertDialogOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface DialogApi {
  alert(options: Omit<AlertDialogOptions, "cancelLabel" | "destructive">): Promise<void>;
  confirm(options: AlertDialogOptions): Promise<boolean>;
}

interface DialogRequest extends AlertDialogOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
  mode: "alert" | "confirm";
}

const DialogContext = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);

  const close = useCallback(
    (confirmed: boolean) => {
      if (!request) {
        return;
      }
      request.resolve(confirmed);
      setRequest(null);
    },
    [request]
  );

  const api = useMemo<DialogApi>(
    () => ({
      alert(options) {
        return new Promise<void>((resolve) => {
          setRequest({
            ...options,
            id: Date.now(),
            mode: "alert",
            resolve: () => resolve()
          });
        });
      },
      confirm(options) {
        return new Promise<boolean>((resolve) => {
          setRequest({
            ...options,
            id: Date.now(),
            mode: "confirm",
            resolve
          });
        });
      }
    }),
    []
  );

  return (
    <DialogContext.Provider value={api}>
      {children}
      {request ? (
        <div className="helix-dialog-backdrop" role="presentation">
          <section
            aria-describedby={request.description ? `helix-dialog-description-${request.id}` : undefined}
            aria-labelledby={`helix-dialog-title-${request.id}`}
            aria-modal="true"
            className="helix-dialog"
            role="alertdialog"
          >
            <h2 id={`helix-dialog-title-${request.id}`}>{request.title}</h2>
            {request.description ? (
              <p id={`helix-dialog-description-${request.id}`}>{request.description}</p>
            ) : null}
            <div className="helix-dialog-actions">
              {request.mode === "confirm" ? (
                <button className="helix-button helix-button-secondary" onClick={() => close(false)} type="button">
                  {request.cancelLabel ?? "Cancel"}
                </button>
              ) : null}
              <button
                className={request.destructive ? "helix-button helix-button-destructive" : "helix-button"}
                onClick={() => close(true)}
                type="button"
              >
                {request.confirmLabel ?? "OK"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </DialogContext.Provider>
  );
}

export function useHelixDialog() {
  const api = useContext(DialogContext);
  if (!api) {
    throw new Error("useHelixDialog must be used inside DialogProvider.");
  }
  return api;
}
