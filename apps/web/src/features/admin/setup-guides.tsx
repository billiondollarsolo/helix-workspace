import { useState } from "react";
import { Button } from "@/components/ui/button";

export function SetupGuides() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="admin-notice" aria-label="Setup guides">
      <p className="m-0 type-body-sm">
        Set up your domain, mail and AI agents with the{" "}
        <a
          className="underline"
          href={new URL("/admin-setup.md", window.location.origin).href}
          target="_blank"
          rel="noopener noreferrer"
        >
          admin checklist
        </a>
        .
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <a
          className="underline type-body-sm"
          href={new URL("/agent-setup.md", window.location.origin).href}
          target="_blank"
          rel="noopener noreferrer"
        >
          AI agent instructions
        </a>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setMessage(null);
            setError(null);
            const copy =
              navigator.clipboard?.writeText(
                new URL("/agent-setup.md", window.location.origin).href,
              ) ?? Promise.reject(new Error("Clipboard unavailable"));
            void copy.then(
              () => setMessage("Agent instructions link copied."),
              () =>
                setError(
                  "Could not copy the link. Open AI agent instructions and copy its address.",
                ),
            );
          }}
        >
          Copy agent instructions link
        </Button>
      </div>
      {message === null ? null : (
        <p role="status" className="mb-0 mt-2 type-body-sm">
          {message}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="mb-0 mt-2 type-body-sm">
          {error}
        </p>
      )}
    </section>
  );
}
