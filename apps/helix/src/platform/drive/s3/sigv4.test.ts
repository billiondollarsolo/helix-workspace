import { describe, expect, it } from "vitest";
import { S3Error } from "./errors.js";
import { decodeRequestPayload } from "./payload.js";
import {
  canonicalRequest,
  deriveSigningKey,
  EMPTY_SHA256,
  parseSigV4,
  sha256Hex,
  signatureFor,
  stringToSign,
  verifySigV4,
  type SigV4RequestInput,
} from "./sigv4.js";

// Examples from the Amazon S3 API Reference, "Authenticating Requests (AWS
// Signature Version 4)": header auth, presigned URLs, and chunked uploads.
const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const SIGNED_AT = new Date("2013-05-24T00:00:00Z");

function authorization(signedHeaders: string, signature: string): string {
  return `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request,SignedHeaders=${signedHeaders},Signature=${signature}`;
}

function verify(input: SigV4RequestInput, now = SIGNED_AT) {
  const parsed = parseSigV4(input);
  if (parsed === null) throw new Error("expected credentials");
  return verifySigV4(input, parsed, SECRET, now);
}

function expectS3Error(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(S3Error);
    expect((error as S3Error).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("AWS SigV4 header authentication (AWS documentation vectors)", () => {
  it("verifies GET Object with a Range header", () => {
    const input = {
      method: "GET",
      path: "/test.txt",
      query: "",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
        authorization: authorization(
          "host;range;x-amz-content-sha256;x-amz-date",
          "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
        ),
      },
    };
    expect(verify(input).parsed.accessKeyId).toBe(ACCESS_KEY);
  });

  it("verifies PUT Object with a signed payload hash", () => {
    const body = Buffer.from("Welcome to Amazon S3.");
    const input = {
      method: "PUT",
      path: "/test%24file.text",
      query: "",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": sha256Hex(body),
        authorization: authorization(
          "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
          "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
        ),
      },
    };
    const verified = verify(input);
    expect(
      decodeRequestPayload({ raw: body, headers: input.headers, auth: verified }).body,
    ).toEqual(body);
    expectS3Error(
      () =>
        decodeRequestPayload({
          raw: Buffer.from("Welcome to Amazon S4."),
          headers: input.headers,
          auth: verified,
        }),
      "XAmzContentSHA256Mismatch",
    );
  });

  it("verifies a bucket sub-resource and a sorted query string", () => {
    const headers = {
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": "20130524T000000Z",
    };
    expect(
      verify({
        method: "GET",
        path: "/",
        query: "lifecycle",
        headers: {
          ...headers,
          authorization: authorization(
            "host;x-amz-content-sha256;x-amz-date",
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
          ),
        },
      }).scope,
    ).toBe("20130524/us-east-1/s3/aws4_request");
    expect(
      verify({
        method: "GET",
        path: "/",
        query: "max-keys=2&prefix=J",
        headers: {
          ...headers,
          authorization: authorization(
            "host;x-amz-content-sha256;x-amz-date",
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
          ),
        },
      }).parsed.signature,
    ).toMatch(/^34b4/u);
  });

  it("rejects a wrong secret, a tampered request, and skewed clocks", () => {
    const input = {
      method: "GET",
      path: "/test.txt",
      query: "",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
        authorization: authorization(
          "host;range;x-amz-content-sha256;x-amz-date",
          "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
        ),
      },
    };
    const parsed = parseSigV4(input);
    if (parsed === null) throw new Error("expected credentials");
    expectS3Error(
      () => verifySigV4(input, parsed, "wrong-secret", SIGNED_AT),
      "SignatureDoesNotMatch",
    );
    expectS3Error(
      () => verify({ ...input, headers: { ...input.headers, range: "bytes=0-10" } }),
      "SignatureDoesNotMatch",
    );
    expectS3Error(
      () => verify(input, new Date(SIGNED_AT.getTime() + 16 * 60 * 1000)),
      "RequestTimeTooSkewed",
    );
    expect(verify(input, new Date(SIGNED_AT.getTime() + 14 * 60 * 1000)).parsed.kind).toBe(
      "header",
    );
  });

  it("rejects unsigned x-amz-* headers but allows the payload hash and date", () => {
    const input = {
      method: "GET",
      path: "/test.txt",
      query: "",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
        authorization: authorization(
          "host;range;x-amz-content-sha256;x-amz-date",
          "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
        ),
      },
    };
    expect(verify(input).headers).toBe(input.headers);
    expectS3Error(
      () => verify({ ...input, headers: { ...input.headers, "x-amz-copy-source": "b/k" } }),
      "AccessDenied",
    );
  });

  it("matches the generic SigV4 test-suite get-vanilla canonical form", () => {
    const input = {
      method: "GET",
      path: "/",
      query: "",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    };
    const canonical = canonicalRequest(input, ["host", "x-amz-date"], EMPTY_SHA256);
    expect(canonical).toBe(
      `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    );
    const key = deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "service",
    );
    expect(
      signatureFor(
        key,
        stringToSign("20150830T123600Z", "20150830/us-east-1/service/aws4_request", canonical),
      ),
    ).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("rejects Signature Version 2 and malformed credentials with S3 errors", () => {
    expectS3Error(
      () =>
        parseSigV4({
          method: "GET",
          path: "/",
          query: "",
          headers: { authorization: "AWS AKID:signature" },
        }),
      "InvalidRequest",
    );
    expectS3Error(
      () =>
        parseSigV4({
          method: "GET",
          path: "/",
          query: "",
          headers: {
            authorization: "AWS4-HMAC-SHA256 Credential=bad,SignedHeaders=host,Signature=00",
            "x-amz-date": "20130524T000000Z",
            "x-amz-content-sha256": EMPTY_SHA256,
          },
        }),
      "AuthorizationHeaderMalformed",
    );
    expect(parseSigV4({ method: "GET", path: "/", query: "", headers: {} })).toBeNull();
  });
});

describe("AWS SigV4 presigned URLs (AWS documentation vector)", () => {
  const query =
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";
  const input = {
    method: "GET",
    path: "/test.txt",
    query,
    headers: { host: "examplebucket.s3.amazonaws.com" },
  };

  it("verifies within the expiry window and rejects afterwards", () => {
    expect(verify(input, new Date(SIGNED_AT.getTime() + 3_600_000)).parsed.kind).toBe("query");
    expectS3Error(() => verify(input, new Date(SIGNED_AT.getTime() + 86_401_000)), "AccessDenied");
  });

  it("rejects a tampered presigned URL", () => {
    expectS3Error(
      () => verify({ ...input, path: "/other.txt" }, new Date(SIGNED_AT.getTime() + 1_000)),
      "SignatureDoesNotMatch",
    );
  });

  it("rejects unsigned x-amz-* headers, such as a smuggled copy source", () => {
    const later = new Date(SIGNED_AT.getTime() + 1_000);
    for (const header of ["x-amz-copy-source", "x-amz-meta-owner", "x-amz-metadata-directive"]) {
      expectS3Error(
        () => verify({ ...input, headers: { ...input.headers, [header]: "x" } }, later),
        "AccessDenied",
      );
    }
  });

  it("drops unsigned Content-Type and Content-MD5 instead of trusting them", () => {
    const verified = verify(
      {
        ...input,
        headers: {
          ...input.headers,
          "content-type": "text/html",
          "content-md5": "1B2M2Y8AsgTpgAmY7PhCfg==",
        },
      },
      new Date(SIGNED_AT.getTime() + 1_000),
    );
    expect(verified.headers["content-type"]).toBeUndefined();
    expect(verified.headers["content-md5"]).toBeUndefined();
    expect(verified.headers.host).toBe("examplebucket.s3.amazonaws.com");
  });
});

describe("aws-chunked streaming uploads (AWS documentation vector)", () => {
  const seed = "4f232c4386841ef735655705268965c44a0e4690baa4adea153f7db9fa80a0a9";
  const headers = {
    host: "s3.amazonaws.com",
    "x-amz-date": "20130524T000000Z",
    "x-amz-storage-class": "REDUCED_REDUNDANCY",
    "content-encoding": "aws-chunked",
    "content-length": "66824",
    "x-amz-decoded-content-length": "66560",
    "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
    authorization: authorization(
      "content-encoding;content-length;host;x-amz-content-sha256;x-amz-date;x-amz-decoded-content-length;x-amz-storage-class",
      seed,
    ),
  };
  const input = { method: "PUT", path: "/examplebucket/chunkObject.txt", query: "", headers };

  function chunked(signatures: readonly string[]): Buffer {
    const first = Buffer.alloc(65_536, "a");
    const second = Buffer.alloc(1_024, "a");
    return Buffer.concat([
      Buffer.from(`10000;chunk-signature=${signatures[0] ?? ""}\r\n`),
      first,
      Buffer.from(`\r\n400;chunk-signature=${signatures[1] ?? ""}\r\n`),
      second,
      Buffer.from(`\r\n0;chunk-signature=${signatures[2] ?? ""}\r\n\r\n`),
    ]);
  }

  const signatures = [
    "ad80c730a21e5b8d04586a2213dd63b9a0e99e0e2307b0ade35a65485a288648",
    "0055627c9e194cb4542bae2aa5492e3c1575bbb81b612b7d234b86a503ef5497",
    "b6c6ea8a5354eaf15b3cb7646744f4275b71ea724fed81ceb9323e279d449df9",
  ];

  it("verifies the seed and every chunk signature", () => {
    const auth = verify(input);
    const raw = chunked(signatures);
    expect(raw.byteLength).toBe(66_824);
    const decoded = decodeRequestPayload({ raw, headers, auth });
    expect(decoded.body.byteLength).toBe(66_560);
  });

  it("rejects a forged chunk signature", () => {
    const auth = verify(input);
    const forged = [signatures[0] ?? "", "0".repeat(64), signatures[2] ?? ""];
    expectS3Error(
      () => decodeRequestPayload({ raw: chunked(forged), headers, auth }),
      "SignatureDoesNotMatch",
    );
  });
});
