import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const maxBodyBytes = Number.parseInt(process.env.MAX_BODY_BYTES ?? "52428800", 10);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/convert/office-to-pdf") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }

    const body = await readJsonBody(request, maxBodyBytes);
    if (!isConversionRequest(body)) {
      writeJson(response, 400, { error: "invalid_request" });
      return;
    }

    const workDir = await mkdtemp(path.join(tmpdir(), "helix-office-preview-"));
    try {
      const inputPath = path.join(workDir, safeFilename(body.name));
      await writeFile(inputPath, Buffer.from(body.contentBase64, "base64"));
      await runLibreOffice(workDir, inputPath);
      const pdfPath = path.join(workDir, `${path.parse(inputPath).name}.pdf`);
      const pdf = await readFile(pdfPath);
      writeJson(response, 200, {
        pdfBase64: pdf.toString("base64"),
        generatedAt: new Date().toISOString(),
      });
    } finally {
      await rm(workDir, { force: true, recursive: true });
    }
  } catch (error) {
    writeJson(response, 500, {
      error: "conversion_failed",
      message: error instanceof Error ? error.message : "Unknown conversion error",
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`helix drive preview converter listening on ${port}`);
});

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function isConversionRequest(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.contentBase64 === "string"
  );
}

function runLibreOffice(workDir, inputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("libreoffice", [
      "--headless",
      "--convert-to",
      "pdf",
      "--outdir",
      workDir,
      inputPath,
    ]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `libreoffice exited with code ${code}`));
    });
  });
}

function safeFilename(name) {
  const cleaned = name.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  return cleaned.length === 0 ? "document" : cleaned;
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}
