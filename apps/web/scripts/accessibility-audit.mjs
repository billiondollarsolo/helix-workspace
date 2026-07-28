#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.HELIX_WEB_BASE_URL || "http://127.0.0.1:4173",
    reportDir: process.env.HELIX_A11Y_REPORT_DIR || path.join(appRoot, "reports", "a11y"),
    routesFile:
      process.env.HELIX_A11Y_ROUTES_FILE || path.join(appRoot, "quality-gates.routes.json"),
    fallbackOk: process.env.HELIX_A11Y_FALLBACK_OK === "1",
    visualSmoke: process.env.HELIX_A11Y_VISUAL_SMOKE !== "0",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") options.baseUrl = argv[++index];
    if (arg === "--report-dir") options.reportDir = argv[++index];
    if (arg === "--routes-file") options.routesFile = argv[++index];
    if (arg === "--fallback-ok") options.fallbackOk = true;
    if (arg === "--skip-visual-smoke") options.visualSmoke = false;
  }

  return options;
}

async function loadRouteConfig(routesFile) {
  const raw = await readFile(routesFile, "utf8");
  const config = JSON.parse(raw);
  if (!Array.isArray(config.routes) || !Array.isArray(config.viewports)) {
    throw new Error(`${routesFile} must define routes and viewports arrays.`);
  }
  return config;
}

async function writeReport(reportDir, report) {
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(
    reportDir,
    `accessibility-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function assertTargetReachable(baseUrl) {
  const response = await fetch(baseUrl, { redirect: "manual" });
  if (response.status >= 500) {
    throw new Error(`${baseUrl} returned HTTP ${response.status}`);
  }
}

function routeUrl(baseUrl, routePath) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${routePath}`;
}

async function prepareTheme(context, theme) {
  await context.addInitScript((nextTheme) => {
    window.localStorage.setItem("helix-color-mode", nextTheme);
  }, theme);
}

async function openRightRail(page) {
  const toggle = await page.$(".right-rail-toggle");
  if (!toggle) {
    return { present: false, opened: false };
  }
  const toggleBox = await toggle.boundingBox();
  if (!toggleBox) {
    return { present: false, opened: false };
  }

  await toggle.click();
  const expanded = await toggle.getAttribute("aria-expanded");
  const rail = await page.$('aside[aria-label="Context panel"]');
  const box = await rail?.boundingBox();
  const panelVisible = Boolean(await page.$(".assistant-rail-panel"));

  return {
    present: true,
    opened: expanded === "true" && Boolean(box && box.width >= 200) && panelVisible,
    width: box?.width ?? 0,
    panelVisible,
  };
}

async function collectVisualSmoke(page, route, viewport, theme, rightRail) {
  return page.evaluate(
    ({ routePath, viewportName, themeName, rightRailState }) => {
      const findings = [];
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const documentWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      );

      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        findings.push({
          type: "reduced-motion-media",
          message: "Reduced motion media query is not active.",
        });
      }

      if (themeName === "dark") {
        const colorScheme = window.getComputedStyle(document.documentElement).colorScheme;
        if (!document.documentElement.classList.contains("dark") && !colorScheme.includes("dark")) {
          findings.push({
            type: "dark-mode",
            message: "Dark theme was requested but the document did not resolve to dark mode.",
          });
        }
      }

      if (documentWidth > viewportWidth + 2) {
        findings.push({
          type: "horizontal-overflow",
          message: `Document scroll width ${documentWidth}px exceeds viewport width ${viewportWidth}px.`,
        });
      }

      if (rightRailState.present && !rightRailState.opened) {
        findings.push({
          type: "right-rail-open",
          message: "Context panel toggle is present but the right rail did not open.",
        });
      }

      const selector = [
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "label",
        "h1",
        "h2",
        "h3",
        '[role="button"]',
        '[role="menuitem"]',
      ].join(",");

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          !element.closest(".sr-only") &&
          !(element instanceof HTMLButtonElement && element.disabled) &&
          !(element instanceof HTMLInputElement && element.disabled) &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity) !== 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= viewportHeight &&
          rect.left <= viewportWidth
        );
      }

      function labelFor(element) {
        const text = element.textContent?.replace(/\s+/g, " ").trim();
        const aria = element.getAttribute("aria-label");
        const placeholder = element.getAttribute("placeholder");
        return text || aria || placeholder || element.tagName.toLowerCase();
      }

      let colorParserContext;

      function normalizedColor(value) {
        colorParserContext ??= document.createElement("canvas").getContext("2d");
        if (colorParserContext === null) return value;
        colorParserContext.fillStyle = "#000000";
        colorParserContext.fillStyle = value;
        return colorParserContext.fillStyle;
      }

      function parsedColor(value) {
        const normalized = normalizedColor(value);
        const match =
          /^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)$/u.exec(
            normalized,
          );
        if (match === null && /^#[\da-f]{6}$/iu.test(normalized)) {
          return {
            r: Number.parseInt(normalized.slice(1, 3), 16),
            g: Number.parseInt(normalized.slice(3, 5), 16),
            b: Number.parseInt(normalized.slice(5, 7), 16),
            a: 1,
          };
        }
        if (match === null && /^#[\da-f]{3}$/iu.test(normalized)) {
          return {
            r: Number.parseInt(normalized[1] + normalized[1], 16),
            g: Number.parseInt(normalized[2] + normalized[2], 16),
            b: Number.parseInt(normalized[3] + normalized[3], 16),
            a: 1,
          };
        }
        if (match === null) return null;
        return {
          r: Number(match[1]),
          g: Number(match[2]),
          b: Number(match[3]),
          a: match[4] === undefined ? 1 : Number(match[4]),
        };
      }

      function blend(foreground, background) {
        const alpha = foreground.a;
        return {
          r: foreground.r * alpha + background.r * (1 - alpha),
          g: foreground.g * alpha + background.g * (1 - alpha),
          b: foreground.b * alpha + background.b * (1 - alpha),
          a: 1,
        };
      }

      function relativeLuminance(color) {
        const components = [color.r, color.g, color.b].map((component) => {
          const channel = component / 255;
          return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
        });
        return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
      }

      function contrastRatio(foreground, background) {
        const foregroundLuminance = relativeLuminance(foreground);
        const backgroundLuminance = relativeLuminance(background);
        const lighter = Math.max(foregroundLuminance, backgroundLuminance);
        const darker = Math.min(foregroundLuminance, backgroundLuminance);
        return (lighter + 0.05) / (darker + 0.05);
      }

      function effectiveBackground(element) {
        let current = element;
        const white = { r: 255, g: 255, b: 255, a: 1 };
        while (current instanceof Element) {
          const backgroundValue = window.getComputedStyle(current).backgroundColor;
          const background = parsedColor(backgroundValue);
          if (background !== null && background.a > 0) {
            return background.a < 1 ? blend(background, white) : background;
          }
          if (
            background === null &&
            backgroundValue !== "transparent" &&
            backgroundValue !== "rgba(0, 0, 0, 0)"
          ) {
            // Chromium preserves CSS Color 4 values such as oklch() in
            // computed styles. The hand-written parser cannot safely compare
            // those values, while axe handles them correctly.
            return null;
          }
          current = current.parentElement;
        }
        const bodyBackground = parsedColor(window.getComputedStyle(document.body).backgroundColor);
        return bodyBackground;
      }

      function requiredContrast(element) {
        const style = window.getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize);
        const fontWeight = Number.parseInt(style.fontWeight, 10);
        const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        return largeText ? 3 : 4.5;
      }

      const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);

      for (const element of elements) {
        const style = window.getComputedStyle(element);
        const label = labelFor(element);
        const clipsX =
          element.scrollWidth > element.clientWidth + 2 &&
          style.overflowX !== "visible" &&
          style.textOverflow !== "ellipsis";
        const clipsY =
          element.scrollHeight > element.clientHeight + 2 && style.overflowY !== "visible";

        if ((clipsX || clipsY) && label.length > 0) {
          const rect = element.getBoundingClientRect();
          findings.push({
            type: "text-clipping",
            target: label.slice(0, 120),
            selector: element.tagName.toLowerCase(),
            message: `${label.slice(0, 80)} appears clipped in ${Math.round(rect.width)}x${Math.round(rect.height)}px.`,
          });
        }

        const foreground = parsedColor(style.color);
        const background = effectiveBackground(element);
        if (foreground !== null && background !== null && label.length > 0) {
          const ratio = contrastRatio(
            foreground.a < 1 ? blend(foreground, background) : foreground,
            background,
          );
          const minimum = requiredContrast(element);
          if (ratio + 0.01 < minimum) {
            findings.push({
              type: "color-contrast",
              target: label.slice(0, 120),
              selector: element.tagName.toLowerCase(),
              message: `${label.slice(0, 80)} has ${ratio.toFixed(2)}:1 contrast; expected at least ${minimum}:1.`,
            });
          }
        }
      }

      const overlapCandidates = elements
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width >= 12 && rect.height >= 12;
        })
        .slice(0, 140);

      for (const element of overlapCandidates) {
        const rect = element.getBoundingClientRect();
        const points = [[rect.left + rect.width / 2, rect.top + rect.height / 2]];
        if (rect.width < 96 || rect.height < 64) {
          points.push(
            [rect.left + Math.min(rect.width - 1, 6), rect.top + Math.min(rect.height - 1, 6)],
            [rect.right - Math.min(rect.width - 1, 6), rect.bottom - Math.min(rect.height - 1, 6)],
          );
        }

        for (const [x, y] of points) {
          if (x < 0 || y < 0 || x > viewportWidth || y > viewportHeight) continue;
          const stack = document.elementsFromPoint(x, y);
          const top = stack.find((candidate) => candidate !== document.documentElement);
          if (!top || top === element || element.contains(top) || top.contains(element)) continue;
          if (!isVisible(top)) continue;
          if (top.closest(".right-rail") && !element.closest(".right-rail")) continue;

          const topLabel = labelFor(top);
          const elementLabel = labelFor(element);
          if (!topLabel || !elementLabel) continue;

          findings.push({
            type: "element-overlap",
            target: elementLabel.slice(0, 120),
            overlapping: topLabel.slice(0, 120),
            message: `${elementLabel.slice(0, 60)} is covered by ${topLabel.slice(0, 60)} near (${Math.round(x)}, ${Math.round(y)}).`,
          });
          break;
        }
      }

      const activeAnimations = document
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running")
        .map((animation) => ({
          name: animation.animationName || animation.id || "anonymous",
          iterations: animation.effect?.getTiming?.().iterations,
        }))
        .filter((animation) => animation.iterations === Infinity);

      for (const animation of activeAnimations) {
        findings.push({
          type: "reduced-motion-animation",
          target: animation.name,
          message: `Infinite animation ${animation.name} is running with reduced motion requested.`,
        });
      }

      return {
        route: routePath,
        viewport: viewportName,
        theme: themeName,
        rightRail: rightRailState,
        findingCount: findings.length,
        findings,
      };
    },
    {
      routePath: route.path,
      viewportName: viewport.name,
      themeName: theme,
      rightRailState: rightRail,
    },
  );
}

async function fallback(options, config, reason) {
  const reportPath = await writeReport(options.reportDir, {
    status: "fallback",
    reason,
    baseUrl: options.baseUrl,
    generatedAt: new Date().toISOString(),
    routes: config.routes,
    viewports: config.viewports,
    manualChecks: [
      "Run keyboard-only navigation on every route and confirm visible focus order.",
      "Check route landmarks, headings, names, roles, and values with browser accessibility tooling.",
      "Confirm text and non-text contrast against WCAG 2.2 AA thresholds in light and dark themes.",
      "Verify reduced-motion mode has no required motion and no continuous animation.",
      "Open the right rail on shell routes and confirm it is visible without clipping or overlap.",
      "Capture mobile, tablet, and desktop screenshots for each route.",
    ],
  });
  console.log(`Accessibility fallback report written: ${reportPath}`);
}

async function runAudit(options, config) {
  await assertTargetReachable(options.baseUrl);
  const [{ chromium }, axeCore] = await Promise.all([
    import("@playwright/test"),
    import("axe-core"),
  ]);
  const browser = await chromium.launch();
  const violations = [];
  const visualFindings = [];
  const auditErrors = [];
  const audited = [];
  const themes = options.visualSmoke ? ["light", "dark"] : ["light"];

  try {
    for (const viewport of config.viewports) {
      for (const theme of themes) {
        let context;
        try {
          context = await browser.newContext({
            colorScheme: theme,
            reducedMotion: "reduce",
            viewport: { width: viewport.width, height: viewport.height },
          });
          await prepareTheme(context, theme);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const route of config.routes) {
            audited.push({
              route: route.path,
              viewport: viewport.name,
              theme,
              violationCount: 0,
              visualFindingCount: 0,
              error: message,
            });
            auditErrors.push({
              route: route.path,
              viewport: viewport.name,
              theme,
              message,
            });
          }
          continue;
        }

        for (const route of config.routes) {
          let page;
          try {
            page = await context.newPage();
            const url = routeUrl(options.baseUrl, route.path);
            await page.goto(url, { timeout: 45_000, waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

            const rightRail = options.visualSmoke
              ? await openRightRail(page)
              : { present: false, opened: false };
            const shouldRunAxe = theme === "light";
            const result = shouldRunAxe
              ? await page.addScriptTag({ content: axeCore.default.source }).then(() =>
                  page.evaluate(async () => {
                    return window.axe.run(document, {
                      resultTypes: ["violations"],
                      runOnly: {
                        type: "tag",
                        values: [
                          "wcag2a",
                          "wcag2aa",
                          "wcag21a",
                          "wcag21aa",
                          "wcag22aa",
                          "best-practice",
                        ],
                      },
                    });
                  }),
                )
              : { violations: [] };

            const visualSmoke = options.visualSmoke
              ? await collectVisualSmoke(page, route, viewport, theme, rightRail)
              : null;

            audited.push({
              route: route.path,
              viewport: viewport.name,
              theme,
              axeSkipped: !shouldRunAxe,
              violationCount: result.violations.length,
              visualFindingCount: visualSmoke?.findingCount ?? 0,
            });
            for (const violation of result.violations) {
              violations.push({
                route: route.path,
                viewport: viewport.name,
                theme,
                id: violation.id,
                impact: violation.impact,
                help: violation.help,
                helpUrl: violation.helpUrl,
                nodes: violation.nodes.map((node) => ({
                  target: node.target,
                  failureSummary: node.failureSummary,
                })),
              });
            }

            if (visualSmoke && visualSmoke.findings.length > 0) {
              visualFindings.push(
                ...visualSmoke.findings.map((finding) => ({
                  route: visualSmoke.route,
                  viewport: visualSmoke.viewport,
                  theme: visualSmoke.theme,
                  ...finding,
                })),
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            audited.push({
              route: route.path,
              viewport: viewport.name,
              theme,
              violationCount: 0,
              visualFindingCount: 0,
              error: message,
            });
            auditErrors.push({
              route: route.path,
              viewport: viewport.name,
              theme,
              message,
            });
          } finally {
            await page?.close().catch(() => {});
          }
        }

        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const reportPath = await writeReport(options.reportDir, {
    status:
      violations.length === 0 && visualFindings.length === 0 && auditErrors.length === 0
        ? "passed"
        : "failed",
    baseUrl: options.baseUrl,
    generatedAt: new Date().toISOString(),
    visualSmoke: options.visualSmoke,
    audited,
    violations,
    visualFindings,
    auditErrors,
  });

  if (violations.length > 0 || visualFindings.length > 0 || auditErrors.length > 0) {
    console.error(
      `Accessibility audit failed with ${violations.length} axe violations, ${visualFindings.length} visual smoke findings, and ${auditErrors.length} execution errors. Report: ${reportPath}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Accessibility audit passed. Report: ${reportPath}`);
}

const options = parseArgs(process.argv.slice(2));
const config = await loadRouteConfig(options.routesFile);

try {
  await runAudit(options, config);
} catch (error) {
  if (options.fallbackOk) {
    await fallback(options, config, error instanceof Error ? error.message : String(error));
  } else {
    console.error(error instanceof Error ? error.message : error);
    console.error("Run with --fallback-ok only when recording a documented manual audit fallback.");
    process.exitCode = 1;
  }
}
