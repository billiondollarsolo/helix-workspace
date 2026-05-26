import { describe, expect, it } from "vitest";
import { assertLocalDemoVerified, isExpectedVolumeSearchHit } from "./verify-local-demo.js";

describe("assertLocalDemoVerified", () => {
  it("accepts a complete local demo snapshot", () => {
    expect(() => {
      assertLocalDemoVerified({
        actorCount: 1,
        betterAuthUserCount: 1,
        betterAuthCredentialCount: 1,
        oauthCredentialCount: 1,
        mailHitCount: 1,
        mailThreadMessageCount: 1,
        docsCount: 1,
        sheetsCount: 1,
        slideDeckCount: 1,
        meetMeetingCount: 1,
        rootDriveEntryCount: 2,
        projectDriveEntryCount: 1,
        calendarEventCount: 3,
        chatRoomCount: 1,
        chatMessageHitCount: 1,
        hasRenovateMail: true,
        hasAmazonMailWithAttachment: true,
        hasQuarterlyPlanningDoc: true,
        hasLaunchMetricsSheet: true,
        hasMvpReadoutDeck: true,
        hasMvpWalkthroughMeet: true,
        hasAiServicesDriveFile: true,
        hasProjectsDriveFolder: true,
        hasTrainingCourseDriveFile: true,
        hasOrderMatchCalendarEvent: true,
        hasProductPlanningCalendarEvent: true,
        hasMvpWalkthroughCalendarEvent: true,
        hasLaunchChatRoom: true,
        hasMailDensityChatMessage: true,
        betterAuthPasswordVerified: true,
        betterAuthSignInVerified: true,
        storageConfigured: true,
        storageObjectCount: 5,
        storageObjectsVerified: true,
        searchConfigured: true,
        searchHitCount: 13,
        searchResultsVerified: true,
        curatedSearchDocumentCount: 13,
        curatedSearchDocumentsVerified: true,
        curatedSearchProjectionFailures: [],
        volumeMailMessageCount: 10_000,
        volumeMailThreadCount: 10_000,
        volumeSearchHitCount: 20,
        volumeSearchResultsVerified: true,
      });
    }).not.toThrow();
  });

  it("reports all missing seeded surfaces", () => {
    const verify = () => {
      assertLocalDemoVerified({
        actorCount: 0,
        betterAuthUserCount: 0,
        betterAuthCredentialCount: 0,
        oauthCredentialCount: 0,
        mailHitCount: 0,
        mailThreadMessageCount: 0,
        docsCount: 0,
        sheetsCount: 0,
        slideDeckCount: 0,
        meetMeetingCount: 0,
        rootDriveEntryCount: 0,
        projectDriveEntryCount: 0,
        calendarEventCount: 0,
        chatRoomCount: 0,
        chatMessageHitCount: 0,
        hasRenovateMail: false,
        hasAmazonMailWithAttachment: false,
        hasQuarterlyPlanningDoc: false,
        hasLaunchMetricsSheet: false,
        hasMvpReadoutDeck: false,
        hasMvpWalkthroughMeet: false,
        hasAiServicesDriveFile: false,
        hasProjectsDriveFolder: false,
        hasTrainingCourseDriveFile: false,
        hasOrderMatchCalendarEvent: false,
        hasProductPlanningCalendarEvent: false,
        hasMvpWalkthroughCalendarEvent: false,
        hasLaunchChatRoom: false,
        hasMailDensityChatMessage: false,
        betterAuthPasswordVerified: false,
        betterAuthSignInVerified: false,
        storageConfigured: true,
        storageObjectCount: 0,
        storageObjectsVerified: false,
        searchConfigured: true,
        searchHitCount: 0,
        searchResultsVerified: false,
        curatedSearchDocumentCount: 0,
        curatedSearchDocumentsVerified: false,
        curatedSearchProjectionFailures: ["mail:Renovate mail"],
        volumeMailMessageCount: 10_000,
        volumeMailThreadCount: 0,
        volumeSearchHitCount: 0,
        volumeSearchResultsVerified: false,
      });
    };
    expect(verify).toThrow("Local demo verification failed");
    expect(verify).toThrow(
      "actor expected >= 1, got 0; Better Auth user linkage expected >= 1, got 0; Better Auth credential expected >= 1, got 0; OAuth credential expected >= 1, got 0; mail search hits expected >= 1, got 0; mail thread messages expected >= 1, got 0; docs list results expected >= 1, got 0; sheets list results expected >= 1, got 0; slides list results expected >= 1, got 0; Meet meeting results expected >= 1, got 0; root Drive entries expected >= 2, got 0; project Drive entries expected >= 1, got 0; calendar events expected >= 2, got 0; chat rooms expected >= 1, got 0; chat message hits expected >= 1, got 0",
    );
    expect(verify).toThrow("Renovate mail was not found");
    expect(verify).toThrow("Launch Metrics Tracker sheet was not found");
    expect(verify).toThrow("MVP Readiness Readout deck was not found");
    expect(verify).toThrow("MVP surface walkthrough Meet room was not found");
    expect(verify).toThrow("Product planning review calendar event was not found");
    expect(verify).toThrow("MVP surface walkthrough calendar event was not found");
    expect(verify).toThrow("Helix launch chat room was not found");
    expect(verify).toThrow("Mail density chat message was not found");
    expect(verify).toThrow("Better Auth email/password login was not found");
    expect(verify).toThrow("Better Auth session login was not found");
    expect(verify).toThrow("seeded storage objects expected >= 5, got 0");
    expect(verify).toThrow("seeded storage object content was not found");
    expect(verify).toThrow("seeded search hits expected >= 13, got 0");
    expect(verify).toThrow("seeded search results was not found");
    expect(verify).toThrow("curated search documents expected >= 13, got 0");
    expect(verify).toThrow("curated search document projections was not found");
    expect(verify).toThrow("curated search projection failures: mail:Renovate mail");
    expect(verify).toThrow("volume mail threads expected >= 10000, got 0");
    expect(verify).toThrow("volume mail search hits expected >= 20, got 0");
    expect(verify).toThrow("volume mail search results was not found");
  });

  it("does not require storage content when no storage provider is configured", () => {
    expect(() => {
      assertLocalDemoVerified({
        actorCount: 1,
        betterAuthUserCount: 1,
        betterAuthCredentialCount: 1,
        oauthCredentialCount: 1,
        mailHitCount: 1,
        mailThreadMessageCount: 1,
        docsCount: 1,
        sheetsCount: 1,
        slideDeckCount: 1,
        meetMeetingCount: 1,
        rootDriveEntryCount: 2,
        projectDriveEntryCount: 1,
        calendarEventCount: 3,
        chatRoomCount: 1,
        chatMessageHitCount: 1,
        hasRenovateMail: true,
        hasAmazonMailWithAttachment: true,
        hasQuarterlyPlanningDoc: true,
        hasLaunchMetricsSheet: true,
        hasMvpReadoutDeck: true,
        hasMvpWalkthroughMeet: true,
        hasAiServicesDriveFile: true,
        hasProjectsDriveFolder: true,
        hasTrainingCourseDriveFile: true,
        hasOrderMatchCalendarEvent: true,
        hasProductPlanningCalendarEvent: true,
        hasMvpWalkthroughCalendarEvent: true,
        hasLaunchChatRoom: true,
        hasMailDensityChatMessage: true,
        betterAuthPasswordVerified: true,
        betterAuthSignInVerified: true,
        storageConfigured: false,
        storageObjectCount: 0,
        storageObjectsVerified: true,
        searchConfigured: false,
        searchHitCount: 0,
        searchResultsVerified: true,
        curatedSearchDocumentCount: 0,
        curatedSearchDocumentsVerified: true,
        curatedSearchProjectionFailures: [],
        volumeMailMessageCount: 10_000,
        volumeMailThreadCount: 10_000,
        volumeSearchHitCount: 0,
        volumeSearchResultsVerified: true,
      });
    }).not.toThrow();
  });
});

describe("isExpectedVolumeSearchHit", () => {
  const orgId = "00000000-0000-4000-8000-000000000100";

  it("accepts deterministic volume mail search projections", () => {
    expect(
      isExpectedVolumeSearchHit(
        {
          id: "mail:00000000-0000-4200-8000-000000000001",
          type: "mail",
          title: "helix-volume-mail-search message 00001",
          body: "helix-volume-mail-search body 00001. Synthetic corpus.",
          url: "/mail/00000000-0000-4100-8000-000000000001?message=00000000-0000-4200-8000-000000000001",
          attributes: {
            orgId,
            threadId: "00000000-0000-4100-8000-000000000001",
            messageId: "00000000-0000-4200-8000-000000000001",
            labels: ["inbox", "volume", "operations"],
            metadata: {
              source: "local-demo-volume",
              marker: "helix-volume-mail-search",
              sequence: 1,
            },
          },
        },
        orgId,
      ),
    ).toBe(true);
  });

  it("rejects generic mail hits that only match the volume query text", () => {
    expect(
      isExpectedVolumeSearchHit(
        {
          id: "mail:00000000-0000-4000-8000-000000000701",
          type: "mail",
          title: "helix-volume-mail-search forwarded result",
          body: "helix-volume-mail-search appeared in an unrelated thread.",
          url: "/mail/00000000-0000-4000-8000-000000000601?message=00000000-0000-4000-8000-000000000701",
          attributes: {
            orgId,
            threadId: "00000000-0000-4000-8000-000000000601",
            messageId: "00000000-0000-4000-8000-000000000701",
            labels: ["inbox"],
            metadata: {
              source: "local-demo",
              marker: "helix-volume-mail-search",
            },
          },
        },
        orgId,
      ),
    ).toBe(false);
  });

  it("rejects volume-shaped hits from the wrong org or missing volume metadata", () => {
    const hit = {
      id: "mail:00000000-0000-4200-8000-000000000002",
      type: "mail",
      title: "helix-volume-mail-search message 00002",
      body: "helix-volume-mail-search body 00002.",
      url: "/mail/00000000-0000-4100-8000-000000000002?message=00000000-0000-4200-8000-000000000002",
      attributes: {
        orgId,
        threadId: "00000000-0000-4100-8000-000000000002",
        messageId: "00000000-0000-4200-8000-000000000002",
        labels: ["inbox", "volume"],
        metadata: {
          source: "local-demo",
          marker: "helix-volume-mail-search",
        },
      },
    };

    expect(isExpectedVolumeSearchHit(hit, orgId)).toBe(false);
    expect(
      isExpectedVolumeSearchHit(
        {
          ...hit,
          attributes: {
            ...hit.attributes,
            orgId: "00000000-0000-4000-8000-000000000999",
            metadata: {
              source: "local-demo-volume",
              marker: "helix-volume-mail-search",
            },
          },
        },
        orgId,
      ),
    ).toBe(false);
  });
});
