/* Slide — renders a single slide in one of the six handoff layouts.
   Ported verbatim from the design handoff (app-slides.jsx → Slide).
   Tokens-only: all colors come from CSS custom properties. */

import type { CSSProperties } from "react";
import { Icons } from "@/components/icons";
import type {
  Slide,
  SlideBackground,
  SplitSlide,
} from "./seed";

/** Resolve the background for a `title` slide. */
function titleBackground(bg: SlideBackground | undefined): string {
  if (bg === "accent") {
    return "linear-gradient(135deg, var(--accent), var(--accent-2))";
  }
  if (bg === "neutral") {
    return "var(--surface-3)";
  }
  return "var(--surface)";
}

const headingStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  margin: 0,
  letterSpacing: "-0.02em",
};

function SplitRight({ slide }: { readonly slide: SplitSlide }) {
  if (slide.rightKind === "quote") {
    return (
      <div>
        <div
          style={{
            fontSize: 22,
            lineHeight: 1.4,
            fontStyle: "italic",
            letterSpacing: "-0.01em",
          }}
        >
          {slide.rightContent as string}
        </div>
        {slide.quoteWho ? (
          <div
            style={{
              fontSize: 14,
              color: "var(--text-3)",
              marginTop: 16,
              fontStyle: "normal",
            }}
          >
            — {slide.quoteWho}
          </div>
        ) : null}
      </div>
    );
  }
  const items = slide.rightContent as readonly string[];
  return (
    <ul style={{ margin: 0, padding: 0, listStyle: "none", width: "100%" }}>
      {items.map((item, index) => (
        <li
          key={item}
          style={{
            padding: "10px 0",
            fontSize: 18,
            fontWeight: 500,
            borderBottom:
              index < items.length - 1 ? "1px solid var(--border)" : "none",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: "var(--accent)",
            }}
          />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Render a slide at full canvas size. */
export function Slide({ slide }: { readonly slide: Slide }) {
  if (slide.layout === "title") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: titleBackground(slide.bg),
          color: slide.bg ? "white" : "var(--text)",
          padding: "10% 12%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
        }}
      >
        {slide.eyebrow ? (
          <div
            style={{
              fontSize: 14,
              opacity: 0.7,
              marginBottom: 16,
              letterSpacing: ".08em",
              textTransform: "uppercase",
            }}
          >
            {slide.eyebrow}
          </div>
        ) : null}
        <h1
          style={{
            fontSize: 48,
            fontWeight: 700,
            margin: 0,
            letterSpacing: "-0.02em",
            lineHeight: 1.05,
          }}
        >
          {slide.title}
        </h1>
        {slide.subtitle ? (
          <div
            style={{
              fontSize: 18,
              marginTop: 16,
              opacity: 0.8,
              maxWidth: 720,
            }}
          >
            {slide.subtitle}
          </div>
        ) : null}
      </div>
    );
  }

  if (slide.layout === "agenda") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: "8% 12%",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2
          style={{
            fontSize: 14,
            color: "var(--text-3)",
            margin: 0,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: ".08em",
          }}
        >
          {slide.title}
        </h2>
        <ol style={{ margin: "32px 0 0", padding: 0, listStyle: "none" }}>
          {slide.items.map((item, index) => (
            <li
              key={item}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 24,
                padding: "16px 0",
                borderBottom:
                  index < slide.items.length - 1
                    ? "1px solid var(--border)"
                    : "none",
              }}
            >
              <span
                style={{
                  fontSize: 20,
                  color: "var(--accent)",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 40,
                }}
              >
                0{index + 1}
              </span>
              <span style={{ fontSize: 28, fontWeight: 500 }}>{item}</span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  if (slide.layout === "stats") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: "8% 10%",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2 style={headingStyle}>{slide.title}</h2>
        {slide.subtitle ? (
          <div
            style={{ fontSize: 16, color: "var(--text-2)", marginTop: 8 }}
          >
            {slide.subtitle}
          </div>
        ) : null}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 24,
            marginTop: 48,
          }}
        >
          {slide.stats.map((stat) => (
            <div
              key={stat.label}
              style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 16 }}
            >
              <div
                style={{
                  fontSize: 56,
                  fontWeight: 700,
                  letterSpacing: "-0.04em",
                  color: "var(--accent)",
                  lineHeight: 1,
                }}
              >
                {stat.value}
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 12 }}>
                {stat.label}
              </div>
              <div
                style={{ fontSize: 13, color: "var(--text-2)", marginTop: 4 }}
              >
                {stat.note}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (slide.layout === "split") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: "8% 10%",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2 style={headingStyle}>{slide.title}</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 48,
            marginTop: 32,
            flex: 1,
          }}
        >
          <div
            style={{
              fontSize: 18,
              lineHeight: 1.55,
              color: "var(--text-2)",
            }}
          >
            {slide.left}
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <SplitRight slide={slide} />
          </div>
        </div>
      </div>
    );
  }

  if (slide.layout === "bullets") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          padding: "8% 10%",
          background: "var(--surface)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2 style={headingStyle}>{slide.title}</h2>
        <ul style={{ margin: "32px 0 0", padding: 0, listStyle: "none" }}>
          {slide.items.map((item) => (
            <li
              key={item}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "14px 0",
                borderTop: "1px solid var(--border)",
                fontSize: 20,
                fontWeight: 500,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: "var(--accent)",
                  flexShrink: 0,
                }}
              />
              {item}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // layout === "image"
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        padding: "6% 10%",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <h2 style={headingStyle}>{slide.title}</h2>
      <div
        style={{
          flex: 1,
          marginTop: 24,
          background: "var(--surface-2)",
          border: "1px dashed var(--border-2)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          backgroundImage:
            "repeating-linear-gradient(45deg, transparent 0 10px, rgba(0,0,0,0.025) 10px 20px)",
        }}
      >
        <Icons.Image size={32} />
        <div className="mono" style={{ fontSize: 12, color: "var(--text-3)" }}>
          {slide.note}
        </div>
      </div>
    </div>
  );
}
