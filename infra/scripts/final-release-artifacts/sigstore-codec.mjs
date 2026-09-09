import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";

export function parseX509Certificate(rawBytes, label) {
  try {
    return new X509Certificate(strictBase64(rawBytes, label));
  } catch {
    throw new Error(`${label} is not a valid DER X.509 certificate`);
  }
}

export function certificateValidAt(certificate, date) {
  return (
    Date.parse(certificate.validFrom) <= date.getTime() &&
    date.getTime() <= Date.parse(certificate.validTo)
  );
}

export function certificateExtensionUtf8(rawCertificate, oid) {
  const oidElement = encodeDerOidElement(oid);
  const offset = rawCertificate.indexOf(oidElement);
  if (offset < 0) throw new Error(`provenance certificate is missing required extension ${oid}`);
  let cursor = offset + oidElement.length;
  let element = readDerElement(rawCertificate, cursor);
  if (element.tag === 0x01) {
    cursor = element.end;
    element = readDerElement(rawCertificate, cursor);
  }
  if (element.tag !== 0x04) {
    throw new Error(`provenance certificate extension ${oid} is malformed`);
  }
  const outerValue = rawCertificate.subarray(element.valueStart, element.valueEnd);
  let inner;
  try {
    inner = readDerElement(outerValue, 0);
  } catch {
    inner = undefined;
  }
  const value =
    inner !== undefined && inner.end === outerValue.length && [0x0c, 0x13, 0x16].includes(inner.tag)
      ? outerValue.subarray(inner.valueStart, inner.valueEnd)
      : outerValue;
  const decoded = value.toString("utf8");
  if (decoded.length === 0 || Buffer.from(decoded, "utf8").compare(value) !== 0) {
    throw new Error(`provenance certificate extension ${oid} is not UTF-8 text`);
  }
  return decoded;
}

function encodeDerOidElement(oid) {
  const arcs = oid.split(".").map((value) => Number(value));
  if (
    arcs.length < 2 ||
    arcs.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    arcs[0] > 2 ||
    (arcs[0] < 2 && arcs[1] > 39)
  ) {
    throw new Error(`invalid certificate extension OID: ${oid}`);
  }
  const body = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f];
    let remaining = Math.floor(arc / 128);
    while (remaining > 0) {
      encoded.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    body.push(...encoded);
  }
  if (body.length >= 128) throw new Error("certificate extension OID is unexpectedly long");
  return Buffer.from([0x06, body.length, ...body]);
}

function readDerElement(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error("truncated DER element");
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  let headerLength = 2;
  if ((length & 0x80) !== 0) {
    const width = length & 0x7f;
    if (width === 0 || width > 4 || offset + 2 + width > buffer.length) {
      throw new Error("invalid DER length");
    }
    length = 0;
    for (let index = 0; index < width; index += 1) {
      length = length * 256 + buffer[offset + 2 + index];
    }
    headerLength += width;
  }
  const valueStart = offset + headerLength;
  const valueEnd = valueStart + length;
  if (valueEnd > buffer.length) throw new Error("truncated DER value");
  return { tag, valueStart, valueEnd, end: valueEnd };
}

export function strictBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_000_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error(`${label} must be canonical base64`);
  return decoded;
}

export function dssePreAuthEncoding(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.byteLength} `),
    payload,
  ]);
}
