import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAuthenticationResults,
  isProviderAcceptedStatus,
} from "./mail-deliverability-evidence.mjs";

test("accepts receiver-reported aligned DKIM and DMARC", () => {
  assert.deepEqual(
    evaluateAuthenticationResults(
      "Authentication-Results: mx.example; dkim=pass header.d=mail.example.com;\r\n\tdmarc=pass header.from=example.com",
      "example.com",
    ),
    {
      status: "passed",
      expectedFromDomain: "example.com",
      observedFromDomain: "example.com",
      dkimDomain: "mail.example.com",
      spfDomain: null,
      dmarcPass: true,
      dkimAligned: true,
      spfAligned: false,
    },
  );
});

test("recognizes durable post-handoff lifecycle states", () => {
  assert.equal(isProviderAcceptedStatus("accepted"), true);
  assert.equal(isProviderAcceptedStatus("delivered"), true);
  assert.equal(isProviderAcceptedStatus("queued"), false);
  assert.equal(isProviderAcceptedStatus("failed"), false);
});

test("accepts aligned SPF and rejects unaligned or missing DMARC", () => {
  assert.equal(
    evaluateAuthenticationResults(
      "Authentication-Results: mx.example; spf=pass smtp.mailfrom=bounces.example.com; dmarc=pass header.from=example.com",
      "example.com",
    ).status,
    "passed",
  );
  assert.equal(
    evaluateAuthenticationResults(
      "Authentication-Results: mx.example; dkim=pass header.d=attacker.test; dmarc=pass header.from=attacker.test",
      "example.com",
    ).status,
    "failed",
  );
  assert.equal(
    evaluateAuthenticationResults(
      "Authentication-Results: mx.example; dkim=pass header.d=example.com; dmarc=none header.from=example.com",
      "example.com",
    ).status,
    "failed",
  );
  assert.equal(
    evaluateAuthenticationResults(
      "Authentication-Results: receiver.example; dkim=fail header.d=example.com; dmarc=fail header.from=example.com\r\nAuthentication-Results: injected.example; dkim=pass header.d=example.com; dmarc=pass header.from=example.com",
      "example.com",
    ).status,
    "failed",
  );
});
