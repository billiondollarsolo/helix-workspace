import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTestSkips } from "./check-test-skips.mjs";

test("only separately executed real-service contracts may skip", () => {
  const result = {
    numPendingTests: 1,
    testResults: [
      {
        name: "/app/platform/ops/real-services.integration.test.ts",
        assertionResults: [
          {
            status: "pending",
            fullName:
              "mandatory real-service contracts uses Redis and NATS instead of process-local substitutes",
          },
        ],
      },
    ],
  };
  checkTestSkips(result);
  result.testResults[0].name = "/app/platform/tenancy/rls.test.ts";
  assert.throws(() => checkTestSkips(result), /Unexpected skipped test/u);
  assert.throws(() => checkTestSkips({ testResults: [], numPendingTests: 1 }), /total/u);
  assert.throws(() => checkTestSkips({}), /Missing/u);
});
