import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import {
  isMvpOnlyBuild,
  mvpBundleBoundaryViolation,
  MVP_ROUTE_FILE_IGNORE_PATTERN,
} from "./src/packaging/mvp-packaging";

const standardChunkBudgetBytes = 500_000;
const initialGraphBudgetBytes = 450_000;
const passwordStrengthChunkBudgetBytes = 850_000;
const devApiTarget =
  process.env.HELIX_E2E_API_BASE_URL ?? process.env.HELIX_API_BASE_URL ?? "http://localhost:3000";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "");
  const mvpOnly = isMvpOnlyBuild(env.VITE_HELIX_MVP_ONLY);

  return {
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        ...(mvpOnly ? { routeFileIgnorePattern: MVP_ROUTE_FILE_IGNORE_PATTERN } : {}),
      }),
      react(),
      tailwindcss(),
      enforceMvpBundleBoundary(mvpOnly),
      enforceBundleBudgets(),
    ],
    resolve: {
      alias: [
        ...(mvpOnly
          ? [
              {
                find: "@/features/_open/converters",
                replacement: fileURLToPath(
                  new URL("./src/packaging/mvp-disabled-converters.ts", import.meta.url),
                ),
              },
            ]
          : []),
        { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
        {
          find: "@helix/sdk-types",
          replacement: fileURLToPath(
            new URL("../../packages/sdk-types/src/index.ts", import.meta.url),
          ),
        },
        {
          find: "@helix/sdk-web",
          replacement: fileURLToPath(
            new URL("../../packages/sdk-web/src/index.ts", import.meta.url),
          ),
        },
      ],
    },
    server: {
      // Dev: proxy the Helix backend surfaces to the local API server (:3000)
      // so the SPA's relative `/api`, `/oauth`, `/trpc`, … calls reach it.
      proxy: Object.fromEntries(
        [
          "/api",
          "/oauth",
          "/trpc",
          "/mcp",
          "/v1",
          "/healthz",
          "/openapi.json",
          "/openapi.yaml",
          "/asyncapi.json",
          "/metrics",
          "/events",
          // Mail realtime (EventSource) — without this the SPA logs
          // "Failed to load resource: 404" for GET /sse/mail in dev.
          "/sse",
          "/ws",
          "/sync",
          "/dav",
          "/.well-known",
        ].map((path) => [path, { target: devApiTarget, changeOrigin: true, ws: true }]),
      ),
    },
    build: {
      // The only intentionally larger lazy chunk is zxcvbn's password corpus.
      // `enforceBundleBudgets` applies stricter graph-aware limits to every
      // initial and non-password chunk.
      chunkSizeWarningLimit: passwordStrengthChunkBudgetBytes / 1_000,
      rollupOptions: {
        output: {
          manualChunks: semanticVendorChunk,
        },
      },
    },
  };
});

function enforceMvpBundleBoundary(mvpOnly: boolean): Plugin {
  return {
    name: "helix-mvp-bundle-boundary",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      if (!mvpOnly) {
        return;
      }

      const violations = new Set<string>();
      for (const entry of Object.values(bundle)) {
        if (entry.type !== "chunk") {
          continue;
        }
        for (const moduleId of Object.keys(entry.modules)) {
          const violation = mvpBundleBoundaryViolation(moduleId);
          if (violation !== null) {
            violations.add(violation);
          }
        }
      }

      if (violations.size > 0) {
        this.error(
          `Production MVP bundle contains forbidden editor modules:\n- ${[...violations].sort().join("\n- ")}`,
        );
      }
    },
  };
}

function semanticVendorChunk(moduleId: string): string | undefined {
  if (isDependency(moduleId, "react") || isDependency(moduleId, "react-dom")) {
    return "vendor-react";
  }
  if (isDependency(moduleId, "scheduler")) {
    return "vendor-react";
  }
  if (
    isDependency(moduleId, "@tanstack/react-query") ||
    isDependency(moduleId, "@tanstack/query-core") ||
    isDependency(moduleId, "@tanstack/react-router") ||
    isDependency(moduleId, "@tanstack/router-core") ||
    isDependency(moduleId, "@tanstack/history")
  ) {
    return "vendor-tanstack";
  }
  if (moduleId.includes("/@tiptap+") || isDependency(moduleId, "linkifyjs")) {
    return "vendor-tiptap";
  }
  if (moduleId.includes("/prosemirror-")) {
    return "vendor-prosemirror";
  }
  if (isDependency(moduleId, "pdf-lib")) {
    return "vendor-pdf-editing";
  }
  if (moduleId.includes("/@pdf-lib+") || isDependency(moduleId, "pako")) {
    return "vendor-pdf-codecs";
  }
  if (isDependency(moduleId, "zxcvbn")) {
    return "password-strength";
  }
  return undefined;
}

function isDependency(moduleId: string, packageName: string): boolean {
  return moduleId.replaceAll("\\", "/").includes(`/node_modules/${packageName}/`);
}

function enforceBundleBudgets(): Plugin {
  return {
    name: "helix-bundle-budgets",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      const chunks = Object.values(bundle).filter((entry) => entry.type === "chunk");
      const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const initialFiles = new Set<string>();

      const visitInitialImport = (fileName: string): void => {
        if (initialFiles.has(fileName)) {
          return;
        }
        const chunk = chunksByFileName.get(fileName);
        if (chunk === undefined) {
          return;
        }
        initialFiles.add(fileName);
        for (const importedFile of chunk.imports) {
          visitInitialImport(importedFile);
        }
      };

      for (const chunk of chunks) {
        if (chunk.isEntry) {
          visitInitialImport(chunk.fileName);
        }
      }

      const initialBytes = [...initialFiles].reduce(
        (total, fileName) =>
          total + Buffer.byteLength(chunksByFileName.get(fileName)?.code ?? "", "utf8"),
        0,
      );
      const violations: string[] = [];
      if (initialBytes > initialGraphBudgetBytes) {
        violations.push(
          `initial JavaScript graph is ${formatBytes(initialBytes)} (budget ${formatBytes(initialGraphBudgetBytes)})`,
        );
      }

      for (const chunk of chunks) {
        const bytes = Buffer.byteLength(chunk.code, "utf8");
        const isPasswordStrengthChunk = Object.keys(chunk.modules).some((moduleId) =>
          isDependency(moduleId, "zxcvbn"),
        );
        const budget = isPasswordStrengthChunk
          ? passwordStrengthChunkBudgetBytes
          : standardChunkBudgetBytes;
        if (bytes > budget) {
          violations.push(
            `${chunk.fileName} is ${formatBytes(bytes)} (budget ${formatBytes(budget)})`,
          );
        }
      }

      if (violations.length > 0) {
        this.error(`Bundle budget exceeded:\n- ${violations.join("\n- ")}`);
      }

      this.info(
        `Bundle budget: initial ${formatBytes(initialBytes)} across ${String(initialFiles.size)} chunks; ${String(chunks.length)} JavaScript chunks total.`,
      );
    },
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000).toFixed(1)} kB`;
}
