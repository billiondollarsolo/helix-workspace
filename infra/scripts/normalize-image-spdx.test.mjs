import { describe, expect, it } from "vitest";
import { validateSpdxDocument } from "./final-release-artifacts.mjs";
import { normalizeImageSpdx } from "./normalize-image-spdx.mjs";

const subject = "ghcr.io/billiondollarsolo/helix-workspace";
const digest = `sha256:${"a".repeat(64)}`;

function rawSpdx() {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "syft-source",
    documentNamespace: "https://anchore.com/syft/image/source",
    creationInfo: {
      created: "2026-07-30T12:00:00Z",
      creators: ["Organization: Anchore, Inc", "Tool: syft-1.30.0"],
      licenseListVersion: "3.26",
    },
    comment: "raw Syft inventory",
    documentDescribes: ["SPDXRef-RawImage"],
    packages: [
      {
        SPDXID: "SPDXRef-Package-alpha",
        name: "alpha",
        versionInfo: "1.0.0",
        downloadLocation: "NOASSERTION",
      },
      {
        SPDXID: "SPDXRef-Package-beta",
        name: "beta",
        versionInfo: "2.0.0",
        downloadLocation: "NOASSERTION",
      },
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-RawImage",
      },
      {
        spdxElementId: "SPDXRef-Package-alpha",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: "SPDXRef-Package-beta",
      },
    ],
    unknownSyftExtension: { ignored: true },
  };
}

describe("production image SPDX normalization", () => {
  it("preserves inventory and emits the strict digest-bound SPDX document", () => {
    const raw = rawSpdx();
    const normalized = normalizeImageSpdx(raw, {
      imageSubject: subject,
      imageDigest: digest,
    });

    expect(normalized.packages.slice(0, raw.packages.length)).toEqual(raw.packages);
    expect(normalized.packages).toHaveLength(3);
    expect(normalized).not.toHaveProperty("unknownSyftExtension");
    expect(normalized.creationInfo).toEqual({
      created: "2026-07-30T12:00:00.000Z",
      creators: raw.creationInfo.creators,
    });
    expect(normalized.name).toBe(`${subject}@${digest}`);
    expect(normalized.documentDescribes).toEqual(["SPDXRef-ContainerImage"]);
    expect(normalized.packages.at(-1)).toMatchObject({
      SPDXID: "SPDXRef-ContainerImage",
      name: subject,
      versionInfo: digest,
      primaryPackagePurpose: "CONTAINER",
      checksums: [{ algorithm: "SHA256", checksumValue: "a".repeat(64) }],
    });
    expect(normalized.relationships).toContainEqual({
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-ContainerImage",
    });
    expect(normalized.relationships).not.toContainEqual(raw.relationships[0]);

    expect(() =>
      validateSpdxDocument(normalized, "normalized SPDX", {
        imageSubject: subject,
        imageDigest: digest,
        packageCount: normalized.packages.length,
      }),
    ).not.toThrow();
  });

  it("uses a collision-free root identifier without changing existing packages", () => {
    const raw = rawSpdx();
    raw.packages.push({ SPDXID: "SPDXRef-ContainerImage", name: "existing" });
    const normalized = normalizeImageSpdx(raw, {
      imageSubject: subject,
      imageDigest: digest,
    });
    expect(normalized.documentDescribes).toEqual(["SPDXRef-ContainerImage-2"]);
    expect(normalized.packages.slice(0, raw.packages.length)).toEqual(raw.packages);
  });

  it("rejects duplicate or invalid SPDX identities and image bindings", () => {
    const duplicate = rawSpdx();
    duplicate.files = [{ SPDXID: "SPDXRef-Package-alpha", fileName: "/duplicate" }];
    expect(() =>
      normalizeImageSpdx(duplicate, { imageSubject: subject, imageDigest: digest }),
    ).toThrow("SPDX identifiers must be valid and unique");
    expect(() =>
      normalizeImageSpdx(rawSpdx(), { imageSubject: `${subject}:latest`, imageDigest: digest }),
    ).toThrow("image subject");
    expect(() =>
      normalizeImageSpdx(rawSpdx(), { imageSubject: subject, imageDigest: "sha256:nope" }),
    ).toThrow("image digest");
    expect(() =>
      normalizeImageSpdx(
        { ...rawSpdx(), spdxVersion: "SPDX-2.2" },
        { imageSubject: subject, imageDigest: digest },
      ),
    ).toThrow("SPDX 2.3");
  });
});
