import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { helixBrowserPlugin } from "./index.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("helix/no-cross-domain-import", () => {
  it("flags cross-domain internal store imports but allows barrels", () => {
    ruleTester.run(
      "no-cross-domain-import",
      helixBrowserPlugin.rules["no-cross-domain-import"],
      {
        valid: [
          {
            code: 'import { sendMail } from "../mail/index.js";',
            filename: "/repo/apps/helix/src/platform/drive/tools.ts",
          },
          {
            code: 'import { sendMail } from "../mail.js";',
            filename: "/repo/apps/helix/src/platform/drive/tools.ts",
          },
          {
            // same domain
            code: 'import { DriveStore } from "./store.js";',
            filename: "/repo/apps/helix/src/platform/drive/tools.ts",
          },
          {
            // non-store cross-domain path
            code: 'import { grant } from "../permissions/grant-object-access.js";',
            filename: "/repo/apps/helix/src/platform/drive/store.ts",
          },
          {
            // composition root outside platform/<domain>
            code: 'import { PostgresMailStore } from "./platform/mail/store.js";',
            filename: "/repo/apps/helix/src/server.ts",
          },
          {
            code: 'import { MailStore } from "../mail/types.js";',
            filename: "/repo/apps/helix/src/platform/drive/tools.ts",
          },
        ],
        invalid: [
          {
            code: 'import { PostgresMailStore } from "../mail/store.js";',
            filename: "/repo/apps/helix/src/platform/drive/tools.ts",
            errors: [{ messageId: "crossDomainStore" }],
          },
          {
            code: 'import { MailStore } from "../mail/store";',
            filename: "/repo/apps/helix/src/platform/calendar/ics.ts",
            errors: [{ messageId: "crossDomainStore" }],
          },
          {
            code: 'export { PostgresDriveStore } from "../drive/store.js";',
            filename: "/repo/apps/helix/src/platform/search/reindex.ts",
            errors: [{ messageId: "crossDomainStore" }],
          },
        ],
      },
    );
  });
});
