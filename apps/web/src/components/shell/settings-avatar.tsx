/* Profile photo: choose an image, crop it to a square (drag or arrow keys to
   move, slider to zoom), and save a 256-pixel copy. The original file never
   leaves the browser. */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import {
  AVATAR_ACCEPT,
  cropRect,
  encodeAvatar,
  initialCrop,
  panCrop,
  type CropState,
} from "./avatar-crop";
import { SettingsDialog } from "./settings-confirm";

const PREVIEW_SIZE = 240;
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

export function SettingsAvatarEditor({
  name,
  avatarDataUrl,
  onSave,
}: {
  readonly name: string;
  readonly avatarDataUrl: string | null;
  /** Saves the new photo, or null to remove it. */
  readonly onSave: (avatarDataUrl: string | null) => Promise<void>;
}) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function choose(file: File | undefined): void {
    setError(null);
    if (file === undefined) return;
    if (!AVATAR_ACCEPT.split(",").includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      setError("Choose an image under 15 MB.");
      return;
    }
    const url = URL.createObjectURL(file);
    const next = new Image();
    next.onload = () => setImage(next);
    next.onerror = () => {
      URL.revokeObjectURL(url);
      setError("That image could not be read. Try another file.");
    };
    next.src = url;
  }

  function closeCropper(): void {
    if (image !== null) URL.revokeObjectURL(image.src);
    setImage(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  }

  async function save(next: string | null): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onSave(next);
      closeCropper();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your photo could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Avatar
        name={name}
        size={72}
        alt={avatarDataUrl === null ? `${name} (initials)` : `Profile photo of ${name}`}
        {...(avatarDataUrl === null ? {} : { src: avatarDataUrl })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={AVATAR_ACCEPT}
          className="sr-only"
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <label
          htmlFor={inputId}
          className="btn sm cursor-pointer has-focus-visible:[outline:var(--focus-ring-width)_solid_var(--focus-ring-color)] has-focus-visible:[outline-offset:var(--focus-ring-offset)]"
        >
          {avatarDataUrl === null ? "Add photo" : "Change photo"}
        </label>
        {avatarDataUrl === null ? null : (
          <button
            type="button"
            className="btn sm ghost"
            disabled={pending}
            onClick={() => void save(null)}
          >
            Remove photo
          </button>
        )}
      </div>
      {error === null || image !== null ? null : (
        <p id={errorId} role="alert" className="m-0 w-full type-body-sm text-destructive">
          {error}
        </p>
      )}
      {image === null ? null : (
        <CropDialog
          image={image}
          pending={pending}
          error={error}
          onCancel={closeCropper}
          onSave={(dataUrl) => void save(dataUrl)}
          onError={setError}
        />
      )}
    </div>
  );
}

function CropDialog({
  image,
  pending,
  error,
  onCancel,
  onSave,
  onError,
}: {
  readonly image: HTMLImageElement;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (dataUrl: string) => void;
  readonly onError: (message: string) => void;
}) {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const [crop, setCrop] = useState<CropState>(() => initialCrop(width, height));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const zoomId = useId();
  const hintId = useId();

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (context == null) return;
    const rect = cropRect(width, height, crop);
    context.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    context.drawImage(
      image,
      rect.x,
      rect.y,
      rect.size,
      rect.size,
      0,
      0,
      PREVIEW_SIZE,
      PREVIEW_SIZE,
    );
  }, [crop, height, image, width]);

  const pan = (deltaX: number, deltaY: number) =>
    setCrop((current) => panCrop(width, height, current, deltaX, deltaY, PREVIEW_SIZE));

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const step = event.shiftKey ? 40 : 10;
    const delta = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    pan(delta[0] ?? 0, delta[1] ?? 0);
  };

  return (
    <SettingsDialog
      title="Crop your photo"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={pending}
            onClick={() => {
              try {
                onSave(encodeAvatar(image, cropRect(width, height, crop)));
              } catch (caught) {
                onError(
                  caught instanceof Error ? caught.message : "The photo could not be resized.",
                );
              }
            }}
          >
            {pending ? "Saving…" : "Save photo"}
          </button>
        </>
      }
    >
      <div className="grid justify-items-center gap-3">
        <canvas
          ref={canvasRef}
          width={PREVIEW_SIZE}
          height={PREVIEW_SIZE}
          tabIndex={0}
          role="img"
          aria-label="Photo crop preview"
          aria-describedby={hintId}
          className="focus-ring cursor-move touch-none rounded-full bg-muted"
          onKeyDown={onKeyDown}
          onPointerDown={(event: PointerEvent<HTMLCanvasElement>) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            const start = dragRef.current;
            if (start === null) return;
            pan(event.clientX - start.x, event.clientY - start.y);
            dragRef.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
        />
        <p id={hintId} className="m-0 type-caption text-muted-foreground">
          Drag or use the arrow keys to position your photo.
        </p>
        <div className="grid w-full gap-1">
          <label htmlFor={zoomId} className="type-body-sm font-medium">
            Zoom
          </label>
          <input
            id={zoomId}
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={crop.zoom}
            onChange={(event) =>
              setCrop((current) => ({ ...current, zoom: Number(event.target.value) }))
            }
            className="w-full accent-[var(--accent)]"
          />
        </div>
        {error === null ? null : (
          <p role="alert" className="m-0 type-body-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </SettingsDialog>
  );
}
