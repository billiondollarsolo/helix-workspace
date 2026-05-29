/**
 * Slide editor side-panel inspector tabs.
 *
 * Hosts the form fields previously rendered inline below the slide canvas in
 * `SlideEditor`. Now live inside the EditorSidePanel tabs (Slide / Format /
 * Notes). State lives in the parent (`NativePresentationEditor`) and flows in
 * via the `SlideEditorController` object.
 *
 * No state lives here — these are presentational form views over the
 * controller. The Save button is repeated in each form so a tester (or user)
 * can submit the slide from whichever tab they happen to be on.
 */
import type { ReactNode } from "react";
import { Icons } from "@/components/icons";
import { SLIDE_LAYOUT_OPTIONS } from "../seed";
import type {
  SlideBackground,
  SlideConnectorArrow,
  SlideConnectorDirection,
  SlideImageFit,
  SlideImageMask,
  SlideLayout,
  SlideMediaType,
  SlideShapeAnimationEasing,
  SlideShapeKind,
  SlideShapeMotionPath,
  SlideShapeTone,
  SlideTransitionDirection,
} from "../seed";
import {
  MediaAssetTable,
  NumberField,
  ShapeAnimationTimeline,
  driveAssetSelectValue,
  normalizeSlideShapeAnimation,
  normalizeSlideTransition,
  shapeLabel,
  slideLayoutLabel,
  ACTION_ROW_STYLE,
  CHECKBOX_LABEL_STYLE,
  EMPTY_STYLE,
  FIELD_STYLE,
  INPUT_STYLE,
  INSPECTOR_TAB_STYLE,
  LABEL_STYLE,
  LAYOUT_SUGGESTION_RESULT_STYLE,
  LAYOUT_SUGGESTION_STYLE,
  MEDIA_PREVIEW_ROW_STYLE,
  SHAPE_ACTION_ROW_STYLE,
  SHAPE_FIELDSET_STYLE,
  SHAPE_GRID_STYLE,
  SHAPE_LEGEND_STYLE,
  TEXTAREA_STYLE,
  TRANSITION_PREVIEW_BUTTON_STYLE,
} from "../native-presentation-editor";
import type { SlideEditorController } from "../slide-editor-controller";

interface InspectorTabProps {
  readonly controller: SlideEditorController | null;
}

export function SlideInspector({ controller }: InspectorTabProps): ReactNode {
  if (controller === null) {
    return (
      <div style={INSPECTOR_TAB_STYLE} aria-label="Slide panel">
        <p style={EMPTY_STYLE}>Select a slide to edit layout, title, and transition.</p>
      </div>
    );
  }
  const { draft, layoutSuggestion, canEditItems } = controller;
  return (
    <form
      style={INSPECTOR_TAB_STYLE}
      aria-label="Slide panel"
      onSubmit={(event) => {
        event.preventDefault();
        controller.save();
      }}
    >
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>Layout</span>
        <select
          aria-label="Slide layout"
          value={draft.layout}
          onChange={(event) => controller.changeLayout(event.target.value as SlideLayout)}
          style={INPUT_STYLE}
        >
          {SLIDE_LAYOUT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div style={LAYOUT_SUGGESTION_STYLE} aria-label="Layout suggestion">
        <button className="btn sm" type="button" onClick={controller.suggestLayout}>
          <Icons.Sparkles /> Suggest layout
        </button>
        {canEditItems ? (
          <button className="btn sm" type="button" onClick={controller.rewriteItems}>
            <Icons.Sparkles /> Rewrite bullets
          </button>
        ) : null}
        <button className="btn sm" type="button" onClick={controller.draftNotes}>
          <Icons.Sparkles /> Draft notes
        </button>
        {layoutSuggestion === null ? null : (
          <div style={LAYOUT_SUGGESTION_RESULT_STYLE}>
            <span>
              Suggested: {slideLayoutLabel(layoutSuggestion.layout)}. {layoutSuggestion.reason}
            </span>
            <button
              className="btn primary sm"
              type="button"
              disabled={layoutSuggestion.layout === draft.layout}
              onClick={controller.applyLayoutSuggestion}
            >
              Apply layout
            </button>
          </div>
        )}
      </div>
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>Title</span>
        <input
          aria-label="Slide title"
          value={draft.title}
          onChange={(event) => controller.patchDraft({ title: event.target.value })}
          style={INPUT_STYLE}
        />
      </label>
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>Transition</span>
        <select
          aria-label="Slide transition"
          value={draft.transition?.type ?? "none"}
          onChange={(event) =>
            controller.patchDraft({
              transition: controller.transitionFromSelection(event.target.value),
            })
          }
          style={INPUT_STYLE}
        >
          <option value="none">None</option>
          <option value="fade">Fade</option>
          <option value="slide">Slide</option>
          <option value="zoom">Zoom</option>
        </select>
      </label>
      {draft.transition !== undefined ? (
        <div style={SHAPE_GRID_STYLE}>
          <NumberField
            label="Transition duration"
            value={draft.transition.durationMs ?? 420}
            min={120}
            max={3_000}
            onChange={(value) =>
              controller.patchDraft({
                transition: normalizeSlideTransition({
                  ...draft.transition,
                  durationMs: value,
                }),
              })
            }
          />
          {draft.transition.type === "slide" ? (
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Direction</span>
              <select
                aria-label="Transition direction"
                value={draft.transition.direction ?? "right"}
                onChange={(event) =>
                  controller.patchDraft({
                    transition: normalizeSlideTransition({
                      ...draft.transition,
                      direction: event.target.value as SlideTransitionDirection,
                    }),
                  })
                }
                style={INPUT_STYLE}
              >
                <option value="right">Right</option>
                <option value="left">Left</option>
                <option value="up">Up</option>
                <option value="down">Down</option>
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="btn sm"
            onClick={controller.previewTransition}
            style={TRANSITION_PREVIEW_BUTTON_STYLE}
          >
            <Icons.Eye /> Preview transition
          </button>
        </div>
      ) : null}
      {draft.layout === "title" ? (
        <>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Eyebrow</span>
            <input
              aria-label="Slide eyebrow"
              value={draft.eyebrow}
              onChange={(event) => controller.patchDraft({ eyebrow: event.target.value })}
              style={INPUT_STYLE}
            />
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Subtitle</span>
            <textarea
              aria-label="Slide subtitle"
              value={draft.subtitle}
              onChange={(event) => controller.patchDraft({ subtitle: event.target.value })}
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Background</span>
            <select
              aria-label="Title background"
              value={draft.bg}
              onChange={(event) =>
                controller.patchDraft({ bg: event.target.value as SlideBackground })
              }
              style={INPUT_STYLE}
            >
              <option value="accent">Accent</option>
              <option value="neutral">Neutral</option>
            </select>
          </label>
        </>
      ) : null}
      {canEditItems ? (
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>
            {draft.layout === "agenda" ? "Agenda items" : "Bullets"}
          </span>
          <textarea
            aria-label={draft.layout === "agenda" ? "Agenda items" : "Slide bullets"}
            value={draft.items}
            onChange={(event) => controller.patchDraft({ items: event.target.value })}
            rows={5}
            style={TEXTAREA_STYLE}
          />
        </label>
      ) : null}
      {draft.layout === "stats" ? (
        <>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Subtitle</span>
            <textarea
              aria-label="Slide subtitle"
              value={draft.subtitle}
              onChange={(event) => controller.patchDraft({ subtitle: event.target.value })}
              rows={3}
              style={TEXTAREA_STYLE}
            />
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Stats</span>
            <textarea
              aria-label="Slide stats"
              value={draft.stats}
              onChange={(event) => controller.patchDraft({ stats: event.target.value })}
              rows={5}
              style={TEXTAREA_STYLE}
            />
          </label>
        </>
      ) : null}
      {draft.layout === "split" ? (
        <>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Left column</span>
            <textarea
              aria-label="Left column"
              value={draft.left}
              onChange={(event) => controller.patchDraft({ left: event.target.value })}
              rows={4}
              style={TEXTAREA_STYLE}
            />
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Right side</span>
            <select
              aria-label="Right side type"
              value={draft.rightKind}
              onChange={(event) =>
                controller.patchDraft({ rightKind: event.target.value as "list" | "quote" })
              }
              style={INPUT_STYLE}
            >
              <option value="list">List</option>
              <option value="quote">Quote</option>
            </select>
          </label>
          <label style={FIELD_STYLE}>
            <span style={LABEL_STYLE}>Right content</span>
            <textarea
              aria-label="Right content"
              value={draft.rightContent}
              onChange={(event) => controller.patchDraft({ rightContent: event.target.value })}
              rows={4}
              style={TEXTAREA_STYLE}
            />
          </label>
          {draft.rightKind === "quote" ? (
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Quote source</span>
              <input
                aria-label="Quote source"
                value={draft.quoteWho}
                onChange={(event) => controller.patchDraft({ quoteWho: event.target.value })}
                style={INPUT_STYLE}
              />
            </label>
          ) : null}
        </>
      ) : null}
      {draft.layout === "image" ? (
        <label style={FIELD_STYLE}>
          <span style={LABEL_STYLE}>Image note</span>
          <textarea
            aria-label="Image note"
            value={draft.note}
            onChange={(event) => controller.patchDraft({ note: event.target.value })}
            rows={5}
            style={TEXTAREA_STYLE}
          />
        </label>
      ) : null}
      <SaveSlideButton controller={controller} />
    </form>
  );
}

export function FormatInspector({ controller }: InspectorTabProps): ReactNode {
  if (controller === null) {
    return (
      <div style={INSPECTOR_TAB_STYLE} aria-label="Format panel">
        <p style={EMPTY_STYLE}>Select a slide to format shapes.</p>
      </div>
    );
  }
  const {
    draft,
    selectedShape,
    selectedShapeIndex,
    mediaShapes,
    animationTimeline,
    driveImageAssets,
    driveMediaAssets,
    imageUploadPending,
    imageUploadError,
    mediaUploadPending,
    mediaUploadError,
    mediaTrimPreviewStatus,
  } = controller;
  return (
    <form
      style={INSPECTOR_TAB_STYLE}
      aria-label="Format panel"
      onSubmit={(event) => {
        event.preventDefault();
        controller.save();
      }}
    >
      {selectedShape === null && draft.shapes.length === 0 ? (
        <p style={EMPTY_STYLE}>Select a shape to format, or add a shape below.</p>
      ) : null}
      {/* TODO(slides): once SlideShape grows text styling, surface font/B/I/U here. */}
      <fieldset style={SHAPE_FIELDSET_STYLE}>
        <legend style={SHAPE_LEGEND_STYLE}>Shapes</legend>
        <div style={SHAPE_ACTION_ROW_STYLE}>
          <button
            className="btn sm"
            type="button"
            aria-label="Add text shape"
            onClick={() => controller.addShape("text")}
          >
            <Icons.Plus /> Text
          </button>
          <button
            className="btn sm"
            type="button"
            aria-label="Add rectangle shape"
            onClick={() => controller.addShape("rectangle")}
          >
            <Icons.Plus /> Rectangle
          </button>
          <button
            className="btn sm"
            type="button"
            aria-label="Add connector shape"
            onClick={() => controller.addShape("connector")}
          >
            <Icons.Plus /> Connector
          </button>
          <button
            className="btn sm"
            type="button"
            aria-label="Add image shape"
            onClick={() => controller.addShape("image")}
          >
            <Icons.Plus /> Image
          </button>
          <button
            className="btn sm"
            type="button"
            aria-label="Add media shape"
            onClick={() => controller.addShape("media")}
          >
            <Icons.Plus /> Media
          </button>
        </div>
        {draft.shapes.length > 0 ? (
          <>
            <label style={FIELD_STYLE}>
              <span style={LABEL_STYLE}>Selected shape</span>
              <select
                aria-label="Slide shape"
                value={selectedShape?.id ?? ""}
                onChange={(event) => controller.setSelectedShapeId(event.target.value)}
                style={INPUT_STYLE}
              >
                {draft.shapes.map((shape, index) => (
                  <option key={shape.id} value={shape.id}>
                    {shapeLabel(shape, index)}
                  </option>
                ))}
              </select>
            </label>
            {mediaShapes.length > 0 ? (
              <MediaAssetTable
                shapes={mediaShapes}
                selectedShapeId={selectedShape?.id ?? null}
                onSelectShape={controller.setSelectedShapeId}
              />
            ) : null}
            {animationTimeline.length > 0 ? (
              <ShapeAnimationTimeline
                rows={animationTimeline}
                selectedShapeId={selectedShape?.id ?? null}
                onSelectShape={controller.setSelectedShapeId}
              />
            ) : null}
            {selectedShape !== null ? (
              <>
                <label style={FIELD_STYLE}>
                  <span style={LABEL_STYLE}>Kind</span>
                  <select
                    aria-label="Shape kind"
                    value={selectedShape.kind}
                    onChange={(event) =>
                      controller.patchSelectedShape({
                        kind: event.target.value as SlideShapeKind,
                      })
                    }
                    style={INPUT_STYLE}
                  >
                    <option value="text">Text</option>
                    <option value="rectangle">Rectangle</option>
                    <option value="connector">Connector</option>
                    <option value="image">Image</option>
                    <option value="media">Media</option>
                  </select>
                </label>
                <label style={FIELD_STYLE}>
                  <span style={LABEL_STYLE}>Text</span>
                  <input
                    aria-label="Shape text"
                    value={selectedShape.text ?? ""}
                    onChange={(event) =>
                      controller.patchSelectedShape({ text: event.target.value })
                    }
                    style={INPUT_STYLE}
                  />
                </label>
                <label style={FIELD_STYLE}>
                  <span style={LABEL_STYLE}>Link</span>
                  <input
                    aria-label="Shape link"
                    type="text"
                    inputMode="url"
                    value={selectedShape.linkUrl ?? ""}
                    onChange={(event) =>
                      controller.patchSelectedShape({ linkUrl: event.target.value })
                    }
                    placeholder="https://example.com"
                    style={INPUT_STYLE}
                  />
                </label>
                {selectedShape.kind === "image" ? (
                  <>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Image URL</span>
                      <input
                        aria-label="Shape image URL"
                        value={selectedShape.imageUrl ?? ""}
                        onChange={(event) =>
                          controller.patchSelectedShape({ imageUrl: event.target.value })
                        }
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Alt text</span>
                      <input
                        aria-label="Shape image alt text"
                        value={selectedShape.imageAlt ?? ""}
                        onChange={(event) =>
                          controller.patchSelectedShape({ imageAlt: event.target.value })
                        }
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Image fit</span>
                      <select
                        aria-label="Shape image fit"
                        value={selectedShape.imageFit ?? "cover"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            imageFit: event.target.value as SlideImageFit,
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="cover">Fill</option>
                        <option value="contain">Fit</option>
                      </select>
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Image mask</span>
                      <select
                        aria-label="Shape image mask"
                        value={selectedShape.imageMask ?? "rounded"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            imageMask: event.target.value as SlideImageMask,
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="rounded">Rounded</option>
                        <option value="rectangle">Rectangle</option>
                        <option value="circle">Circle</option>
                      </select>
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Upload image</span>
                      <input
                        aria-label="Upload shape image"
                        type="file"
                        accept="image/*"
                        disabled={imageUploadPending}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          controller.uploadSelectedShapeImage(file);
                        }}
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Drive image</span>
                      <select
                        aria-label="Drive image asset"
                        value={driveAssetSelectValue(selectedShape.imageUrl, driveImageAssets)}
                        disabled={driveImageAssets.length === 0}
                        onChange={(event) => controller.pickDriveImageAsset(event.target.value)}
                        style={INPUT_STYLE}
                      >
                        <option value="">
                          {driveImageAssets.length === 0 ? "No Drive images" : "Choose image"}
                        </option>
                        {driveImageAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {imageUploadPending ? (
                      <div role="status" style={EMPTY_STYLE}>
                        Uploading image...
                      </div>
                    ) : null}
                    {imageUploadError ? (
                      <div role="alert" style={EMPTY_STYLE}>
                        Image upload failed.
                      </div>
                    ) : null}
                  </>
                ) : null}
                {selectedShape.kind === "media" ? (
                  <>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Media URL</span>
                      <input
                        aria-label="Shape media URL"
                        value={selectedShape.mediaUrl ?? ""}
                        onChange={(event) =>
                          controller.patchSelectedShape({ mediaUrl: event.target.value })
                        }
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Media title</span>
                      <input
                        aria-label="Shape media title"
                        value={selectedShape.mediaTitle ?? ""}
                        onChange={(event) =>
                          controller.patchSelectedShape({ mediaTitle: event.target.value })
                        }
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Media type</span>
                      <select
                        aria-label="Shape media type"
                        value={selectedShape.mediaType ?? "video"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            mediaType: event.target.value as SlideMediaType,
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="video">Video</option>
                        <option value="audio">Audio</option>
                      </select>
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Caption track URL</span>
                      <input
                        aria-label="Shape media caption URL"
                        value={selectedShape.mediaCaptionUrl ?? ""}
                        onChange={(event) =>
                          controller.patchSelectedShape({ mediaCaptionUrl: event.target.value })
                        }
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Caption label</span>
                      <input
                        aria-label="Shape media caption label"
                        value={selectedShape.mediaCaptionLabel ?? ""}
                        onChange={(event) =>
                          controller.patchSelectedShape({ mediaCaptionLabel: event.target.value })
                        }
                        style={INPUT_STYLE}
                      />
                    </label>
                    {(selectedShape.mediaType ?? "video") === "video" ? (
                      <>
                        <label style={FIELD_STYLE}>
                          <span style={LABEL_STYLE}>Poster URL</span>
                          <input
                            aria-label="Shape media poster URL"
                            value={selectedShape.mediaPosterUrl ?? ""}
                            onChange={(event) =>
                              controller.patchSelectedShape({
                                mediaPosterUrl: event.target.value,
                              })
                            }
                            style={INPUT_STYLE}
                          />
                        </label>
                        <label style={FIELD_STYLE}>
                          <span style={LABEL_STYLE}>Drive poster</span>
                          <select
                            aria-label="Drive poster image"
                            value={driveAssetSelectValue(
                              selectedShape.mediaPosterUrl,
                              driveImageAssets,
                            )}
                            disabled={driveImageAssets.length === 0}
                            onChange={(event) =>
                              controller.pickDriveMediaPosterAsset(event.target.value)
                            }
                            style={INPUT_STYLE}
                          >
                            <option value="">
                              {driveImageAssets.length === 0
                                ? "No Drive images"
                                : "Choose poster"}
                            </option>
                            {driveImageAssets.map((asset) => (
                              <option key={asset.id} value={asset.id}>
                                {asset.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div style={SHAPE_GRID_STYLE}>
                          <NumberField
                            label="Shape media trim start"
                            value={selectedShape.mediaStartSeconds ?? 0}
                            max={86_400}
                            onChange={(value) =>
                              controller.patchSelectedShape({ mediaStartSeconds: value })
                            }
                          />
                          <NumberField
                            label="Shape media trim end"
                            value={selectedShape.mediaEndSeconds ?? 0}
                            max={86_400}
                            onChange={(value) =>
                              controller.patchSelectedShape({ mediaEndSeconds: value })
                            }
                          />
                        </div>
                        <div style={MEDIA_PREVIEW_ROW_STYLE}>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={(selectedShape.mediaUrl?.trim().length ?? 0) === 0}
                            onClick={controller.previewSelectedMediaTrim}
                          >
                            <Icons.Video /> Preview trim
                          </button>
                          {mediaTrimPreviewStatus.length > 0 ? (
                            <span role="status" style={EMPTY_STYLE}>
                              {mediaTrimPreviewStatus}
                            </span>
                          ) : null}
                        </div>
                        <div style={SHAPE_GRID_STYLE}>
                          <label style={CHECKBOX_LABEL_STYLE}>
                            <input
                              aria-label="Shape media autoplay"
                              type="checkbox"
                              checked={selectedShape.mediaAutoplay === true}
                              onChange={(event) =>
                                controller.patchSelectedShape({
                                  mediaAutoplay: event.target.checked,
                                })
                              }
                            />
                            Autoplay
                          </label>
                          <label style={CHECKBOX_LABEL_STYLE}>
                            <input
                              aria-label="Shape media loop"
                              type="checkbox"
                              checked={selectedShape.mediaLoop === true}
                              onChange={(event) =>
                                controller.patchSelectedShape({
                                  mediaLoop: event.target.checked,
                                })
                              }
                            />
                            Loop
                          </label>
                          <label style={CHECKBOX_LABEL_STYLE}>
                            <input
                              aria-label="Shape media muted"
                              type="checkbox"
                              checked={selectedShape.mediaMuted === true}
                              onChange={(event) =>
                                controller.patchSelectedShape({
                                  mediaMuted: event.target.checked,
                                })
                              }
                            />
                            Muted
                          </label>
                        </div>
                      </>
                    ) : null}
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Upload media</span>
                      <input
                        aria-label="Upload shape media"
                        type="file"
                        accept="video/*,audio/*"
                        disabled={mediaUploadPending}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          controller.uploadSelectedShapeMedia(file);
                        }}
                        style={INPUT_STYLE}
                      />
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Drive media</span>
                      <select
                        aria-label="Drive media asset"
                        value={driveAssetSelectValue(selectedShape.mediaUrl, driveMediaAssets)}
                        disabled={driveMediaAssets.length === 0}
                        onChange={(event) => controller.pickDriveMediaAsset(event.target.value)}
                        style={INPUT_STYLE}
                      >
                        <option value="">
                          {driveMediaAssets.length === 0 ? "No Drive media" : "Choose media"}
                        </option>
                        {driveMediaAssets.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {mediaUploadPending ? (
                      <div role="status" style={EMPTY_STYLE}>
                        Uploading media...
                      </div>
                    ) : null}
                    {mediaUploadError ? (
                      <div role="alert" style={EMPTY_STYLE}>
                        Media upload failed.
                      </div>
                    ) : null}
                  </>
                ) : null}
                <div style={SHAPE_GRID_STYLE}>
                  <NumberField
                    label="Shape x"
                    value={selectedShape.x}
                    onChange={(value) => controller.patchSelectedShape({ x: value })}
                  />
                  <NumberField
                    label="Shape y"
                    value={selectedShape.y}
                    onChange={(value) => controller.patchSelectedShape({ y: value })}
                  />
                  <NumberField
                    label="Shape width"
                    value={selectedShape.width}
                    onChange={(value) => controller.patchSelectedShape({ width: value })}
                  />
                  <NumberField
                    label="Shape height"
                    value={selectedShape.height}
                    onChange={(value) => controller.patchSelectedShape({ height: value })}
                  />
                </div>
                <label style={FIELD_STYLE}>
                  <span style={LABEL_STYLE}>Tone</span>
                  <select
                    aria-label="Shape tone"
                    value={selectedShape.tone ?? "accent"}
                    onChange={(event) =>
                      controller.patchSelectedShape({
                        tone: event.target.value as SlideShapeTone,
                      })
                    }
                    style={INPUT_STYLE}
                  >
                    <option value="accent">Accent</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label style={FIELD_STYLE}>
                  <span style={LABEL_STYLE}>Animation</span>
                  <select
                    aria-label="Shape animation"
                    value={selectedShape.animation?.type ?? "none"}
                    onChange={(event) =>
                      controller.patchSelectedShape({
                        animation: controller.animationFromSelection(
                          event.target.value,
                          selectedShape.animation,
                          selectedShapeIndex,
                        ),
                      })
                    }
                    style={INPUT_STYLE}
                  >
                    <option value="none">None</option>
                    <option value="fade">Entrance fade</option>
                    <option value="fly">Entrance fly</option>
                    <option value="zoom">Entrance zoom</option>
                  </select>
                </label>
                {selectedShape.animation !== undefined ? (
                  <div style={SHAPE_GRID_STYLE}>
                    <NumberField
                      label="Animation order"
                      value={selectedShape.animation.order ?? Math.max(selectedShapeIndex, 0)}
                      max={199}
                      onChange={(value) =>
                        controller.patchSelectedShape({
                          animation: normalizeSlideShapeAnimation({
                            ...selectedShape.animation,
                            order: value,
                          }),
                        })
                      }
                    />
                    <NumberField
                      label="Animation duration"
                      value={selectedShape.animation.durationMs ?? 620}
                      min={120}
                      max={5_000}
                      onChange={(value) =>
                        controller.patchSelectedShape({
                          animation: normalizeSlideShapeAnimation({
                            ...selectedShape.animation,
                            durationMs: value,
                          }),
                        })
                      }
                    />
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Easing</span>
                      <select
                        aria-label="Animation easing"
                        value={selectedShape.animation.easing ?? "standard"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            animation: normalizeSlideShapeAnimation({
                              ...selectedShape.animation,
                              easing: event.target.value as SlideShapeAnimationEasing,
                            }),
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="standard">Standard</option>
                        <option value="linear">Linear</option>
                        <option value="easeIn">Ease in</option>
                        <option value="easeOut">Ease out</option>
                        <option value="easeInOut">Ease in/out</option>
                      </select>
                    </label>
                    {selectedShape.animation.type === "fly" ? (
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Motion path</span>
                        <select
                          aria-label="Shape motion path"
                          value={selectedShape.animation.motionPath ?? "left"}
                          onChange={(event) =>
                            controller.patchSelectedShape({
                              animation: normalizeSlideShapeAnimation({
                                ...selectedShape.animation,
                                motionPath: event.target.value as SlideShapeMotionPath,
                              }),
                            })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="up">Up</option>
                          <option value="down">Down</option>
                        </select>
                      </label>
                    ) : null}
                  </div>
                ) : null}
                <label style={FIELD_STYLE}>
                  <span style={LABEL_STYLE}>Exit animation</span>
                  <select
                    aria-label="Shape exit animation"
                    value={selectedShape.exitAnimation?.type ?? "none"}
                    onChange={(event) =>
                      controller.patchSelectedShape({
                        exitAnimation: controller.animationFromSelection(
                          event.target.value,
                          selectedShape.exitAnimation,
                          selectedShapeIndex,
                        ),
                      })
                    }
                    style={INPUT_STYLE}
                  >
                    <option value="none">None</option>
                    <option value="fade">Exit fade</option>
                    <option value="fly">Exit fly</option>
                    <option value="zoom">Exit zoom</option>
                  </select>
                </label>
                {selectedShape.exitAnimation !== undefined ? (
                  <div style={SHAPE_GRID_STYLE}>
                    <NumberField
                      label="Exit animation order"
                      value={
                        selectedShape.exitAnimation.order ?? Math.max(selectedShapeIndex, 0)
                      }
                      max={199}
                      onChange={(value) =>
                        controller.patchSelectedShape({
                          exitAnimation: normalizeSlideShapeAnimation({
                            ...selectedShape.exitAnimation,
                            order: value,
                          }),
                        })
                      }
                    />
                    <NumberField
                      label="Exit animation duration"
                      value={selectedShape.exitAnimation.durationMs ?? 620}
                      min={120}
                      max={5_000}
                      onChange={(value) =>
                        controller.patchSelectedShape({
                          exitAnimation: normalizeSlideShapeAnimation({
                            ...selectedShape.exitAnimation,
                            durationMs: value,
                          }),
                        })
                      }
                    />
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Exit easing</span>
                      <select
                        aria-label="Exit animation easing"
                        value={selectedShape.exitAnimation.easing ?? "standard"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            exitAnimation: normalizeSlideShapeAnimation({
                              ...selectedShape.exitAnimation,
                              easing: event.target.value as SlideShapeAnimationEasing,
                            }),
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="standard">Standard</option>
                        <option value="linear">Linear</option>
                        <option value="easeIn">Ease in</option>
                        <option value="easeOut">Ease out</option>
                        <option value="easeInOut">Ease in/out</option>
                      </select>
                    </label>
                    {selectedShape.exitAnimation.type === "fly" ? (
                      <label style={FIELD_STYLE}>
                        <span style={LABEL_STYLE}>Exit motion path</span>
                        <select
                          aria-label="Shape exit motion path"
                          value={selectedShape.exitAnimation.motionPath ?? "left"}
                          onChange={(event) =>
                            controller.patchSelectedShape({
                              exitAnimation: normalizeSlideShapeAnimation({
                                ...selectedShape.exitAnimation,
                                motionPath: event.target.value as SlideShapeMotionPath,
                              }),
                            })
                          }
                          style={INPUT_STYLE}
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="up">Up</option>
                          <option value="down">Down</option>
                        </select>
                      </label>
                    ) : null}
                  </div>
                ) : null}
                {selectedShape.kind === "connector" ? (
                  <>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Direction</span>
                      <select
                        aria-label="Connector direction"
                        value={selectedShape.connectorDirection ?? "up"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            connectorDirection: event.target.value as SlideConnectorDirection,
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="up">Up</option>
                        <option value="down">Down</option>
                      </select>
                    </label>
                    <label style={FIELD_STYLE}>
                      <span style={LABEL_STYLE}>Arrow</span>
                      <select
                        aria-label="Connector arrow"
                        value={selectedShape.connectorArrow ?? "end"}
                        onChange={(event) =>
                          controller.patchSelectedShape({
                            connectorArrow: event.target.value as SlideConnectorArrow,
                          })
                        }
                        style={INPUT_STYLE}
                      >
                        <option value="start">Start</option>
                        <option value="end">End</option>
                        <option value="both">Both</option>
                        <option value="none">None</option>
                      </select>
                    </label>
                  </>
                ) : null}
                <div style={SHAPE_ACTION_ROW_STYLE}>
                  <button
                    className="btn sm"
                    type="button"
                    aria-label="Send shape backward"
                    disabled={selectedShapeIndex <= 0}
                    onClick={() => controller.moveSelectedShape(-1)}
                  >
                    <Icons.ChevronDown style={{ transform: "rotate(90deg)" }} /> Back
                  </button>
                  <button
                    className="btn sm"
                    type="button"
                    aria-label="Bring shape forward"
                    disabled={
                      selectedShapeIndex < 0 || selectedShapeIndex >= draft.shapes.length - 1
                    }
                    onClick={() => controller.moveSelectedShape(1)}
                  >
                    <Icons.ChevronDown style={{ transform: "rotate(-90deg)" }} /> Front
                  </button>
                </div>
                <button
                  className="btn sm"
                  type="button"
                  onClick={controller.deleteSelectedShape}
                >
                  <Icons.Trash /> Delete shape
                </button>
              </>
            ) : null}
          </>
        ) : (
          <p style={EMPTY_STYLE}>No shapes</p>
        )}
      </fieldset>
      <SaveSlideButton controller={controller} />
    </form>
  );
}

export function NotesInspector({ controller }: InspectorTabProps): ReactNode {
  if (controller === null) {
    return (
      <div style={INSPECTOR_TAB_STYLE} aria-label="Notes panel">
        <p style={EMPTY_STYLE}>Select a slide to edit speaker notes.</p>
      </div>
    );
  }
  return (
    <form
      style={INSPECTOR_TAB_STYLE}
      aria-label="Notes panel"
      onSubmit={(event) => {
        event.preventDefault();
        controller.save();
      }}
    >
      <label style={FIELD_STYLE}>
        <span style={LABEL_STYLE}>Speaker notes</span>
        <textarea
          aria-label="Speaker notes"
          value={controller.draft.speakerNotes}
          onChange={(event) => controller.patchDraft({ speakerNotes: event.target.value })}
          rows={10}
          style={TEXTAREA_STYLE}
        />
      </label>
      <SaveSlideButton controller={controller} />
    </form>
  );
}

function SaveSlideButton({
  controller,
}: {
  readonly controller: SlideEditorController;
}): ReactNode {
  return (
    <div style={ACTION_ROW_STYLE}>
      <button type="submit" className="btn sm primary" disabled={!controller.canSave}>
        {controller.saving ? "Saving..." : "Save slide"}
      </button>
    </div>
  );
}
