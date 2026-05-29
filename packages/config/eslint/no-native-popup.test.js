import { Linter, RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import { helixBrowserPlugin, helixBrowserRules } from "./index.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    parserOptions: {
      ecmaFeatures: {
        jsx: true,
      },
    },
    sourceType: "module",
  },
});

describe("helix/no-native-popup", () => {
  it("enforces native popup discipline", () => {
    ruleTester.run("no-native-popup", helixBrowserPlugin.rules["no-native-popup"], {
      valid: ["dialog.alert({ title: 'Saved' });", "navigation.open('/docs');"],
      invalid: [
        {
          code: "alert('Saved');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "window.alert('Saved');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "window['confirm']('Delete?');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "window.confirm('Delete?');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "window.prompt('Name');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "window.open('/oauth');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "globalThis.open('/oauth');",
          errors: [{ messageId: "nativePopup" }],
        },
        {
          code: "window.addEventListener('beforeunload', onUnload);",
          errors: [{ messageId: "beforeUnload" }],
        },
        {
          code: "const eventName = `beforeunload`;",
          errors: [{ messageId: "beforeUnload" }],
        },
      ],
    });
  });

  it("requires justified next-line disables for native popup exceptions", () => {
    const linter = new Linter({ configType: "flat" });
    const config = [
      {
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: "module",
        },
        plugins: {
          helix: helixBrowserPlugin,
        },
        rules: helixBrowserRules,
      },
    ];

    expect(
      linter.verify(
        "// eslint-disable-next-line helix/no-native-popup -- External OAuth provider requires a top-level browsing context.\nwindow.open('/oauth');",
        config,
      ),
    ).toEqual([]);

    expect(
      linter
        .verify("// eslint-disable-next-line helix/no-native-popup\nwindow.open('/oauth');", config)
        .map((message) => message.messageId),
    ).toEqual(["disableJustification"]);

    expect(
      linter
        .verify("// eslint-disable-next-line\nwindow.open('/oauth');", config)
        .map((message) => message.messageId),
    ).toEqual(["disableDirective"]);

    expect(
      linter
        .verify(
          "/* eslint-disable helix/no-native-popup -- temporary */\nwindow.open('/oauth');",
          config,
        )
        .map((message) => message.messageId),
    ).toEqual(["disableDirective"]);
  });
});

describe("helix/use-query-options", () => {
  it("requires queryOptions factories for useQuery", () => {
    ruleTester.run("use-query-options", helixBrowserPlugin.rules["use-query-options"], {
      valid: [
        "useQuery(mailSearchQueryOptions());",
        "useQuery(chatMessageListQueryOptions(roomId, 50));",
        "useQuery({ ...docsDocumentExportQueryOptions({ docId }), enabled: Boolean(docId) });",
        "client.useQuery({ queryKey: ['not-react-query'] });",
      ],
      invalid: [
        {
          code: "useQuery({ queryKey: ['mail'], queryFn: fetchMail });",
          errors: [{ messageId: "queryOptions" }],
        },
        {
          code: "useQuery();",
          errors: [{ messageId: "queryOptions" }],
        },
        {
          code: "useQuery(buildQuery());",
          errors: [{ messageId: "queryOptions" }],
        },
      ],
    });
  });
});

describe("helix/mutation-discipline", () => {
  it("requires rollback handlers for useMutation", () => {
    ruleTester.run("mutation-discipline", helixBrowserPlugin.rules["mutation-discipline"], {
      valid: [
        "useMutation({ mutationFn: saveMail, onMutate: snapshotMail, onError: restoreMail });",
        "useMutation({ 'onMutate': snapshotMail, 'onError': restoreMail });",
        "client.useMutation({ mutationFn: saveMail });",
        "const useMutation = makeMutationFactory(); useMutationClient({ mutationFn: saveMail });",
      ],
      invalid: [
        {
          code: "useMutation({ mutationFn: saveMail });",
          errors: [{ messageId: "mutationDiscipline" }],
        },
        {
          code: "useMutation({ mutationFn: saveMail, onMutate: snapshotMail });",
          errors: [{ messageId: "mutationDiscipline" }],
        },
        {
          code: "useMutation({ mutationFn: saveMail, onError: restoreMail });",
          errors: [{ messageId: "mutationDiscipline" }],
        },
        {
          code: "useMutation(buildMutationOptions());",
          errors: [{ messageId: "mutationDiscipline" }],
        },
        {
          code: "useMutation();",
          errors: [{ messageId: "mutationDiscipline" }],
        },
      ],
    });
  });
});

describe("helix/query-refresh-discipline", () => {
  it("requires invalidation helpers instead of direct query refetches", () => {
    ruleTester.run(
      "query-refresh-discipline",
      helixBrowserPlugin.rules["query-refresh-discipline"],
      {
        valid: [
          "queryClient.invalidateQueries({ queryKey: mailQueryKeys.search(input) });",
          "invalidateMailSearch(queryClient, input);",
          "refreshButton.onClick();",
          "const refetch = query.refetch;",
        ],
        invalid: [
          {
            code: "mailQuery." + "refetch();",
            errors: [{ messageId: "queryRefreshDiscipline" }],
          },
          {
            code: "void mailQuery." + "refetch();",
            errors: [{ messageId: "queryRefreshDiscipline" }],
          },
          {
            code: "mailQuery['refetch']();",
            errors: [{ messageId: "queryRefreshDiscipline" }],
          },
        ],
      },
    );
  });
});

describe("helix/direct-drizzle-tenant-query", () => {
  it("requires tenantScoped() for org-scoped Drizzle tables", () => {
    ruleTester.run(
      "direct-drizzle-tenant-query",
      helixBrowserPlugin.rules["direct-drizzle-tenant-query"],
      {
        valid: [
          "tenantScoped(objects, orgId).select({ id: objects.id });",
          "tenantScoped(docsDocuments, orgId).update({ title });",
          "db.select().from(plans);",
          "db.select().from(platformConfig);",
          "query.from(dynamicTable);",
          "sql`select * from objects where org_id = ${orgId}`;",
        ],
        invalid: [
          {
            code: "db.select().from(objects);",
            errors: [{ messageId: "directDrizzleTenantQuery" }],
          },
          {
            code: "db.insert(docsDocuments).values(input);",
            errors: [{ messageId: "directDrizzleTenantQuery" }],
          },
          {
            code: "db.update(permissions).set({ role });",
            errors: [{ messageId: "directDrizzleTenantQuery" }],
          },
          {
            code: "db['delete'](messages).where(eq(messages.id, id));",
            errors: [{ messageId: "directDrizzleTenantQuery" }],
          },
        ],
      },
    );
  });
});

describe("helix/pacer-discipline", () => {
  it("requires TanStack Pacer hooks instead of native browser timers", () => {
    ruleTester.run("pacer-discipline", helixBrowserPlugin.rules["pacer-discipline"], {
      valid: [
        "useTimeout(() => saveDraft(), 250);",
        "useInterval(() => refresh(), 1000);",
        "timer.setTimeout(() => refresh(), 1000);",
        "clock.clearInterval(handle);",
        "const delay = setTimeout;",
      ],
      invalid: [
        {
          code: "setTimeout(() => refresh(), 1000);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
        {
          code: "clearTimeout(handle);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
        {
          code: "setInterval(() => refresh(), 1000);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
        {
          code: "clearInterval(handle);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
        {
          code: "window.setTimeout(() => refresh(), 1000);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
        {
          code: "globalThis.clearInterval(handle);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
        {
          code: "window['setInterval'](() => refresh(), 1000);",
          errors: [{ messageId: "pacerDiscipline" }],
        },
      ],
    });
  });
});

describe("helix/internal-link", () => {
  it("requires Link for internal app navigation", () => {
    ruleTester.run("internal-link", helixBrowserPlugin.rules["internal-link"], {
      valid: [
        '<Link to="/assistant">Open</Link>;',
        '<a href="https://example.com">External</a>;',
        '<a href="mailto:help@example.com">Mail</a>;',
      ],
      invalid: [
        {
          code: '<a href="/assistant">Open</a>;',
          errors: [{ messageId: "internalAnchor" }],
        },
        {
          code: '<a href="./settings">Settings</a>;',
          errors: [{ messageId: "internalAnchor" }],
        },
      ],
    });
  });
});
