/* Admin → Mail → Spam filtering: SpamAssassin status, the AI second pass, and
 * the organization's AI decision model (settings and report). */

import { useQuery } from "@tanstack/react-query";
import { Shield as ShieldIcon } from "lucide-react";
import { formatCount } from "@/features/admin/console/format";
import {
  ErrorNotice,
  LoadingState,
  PanelHeading,
  StatusChip,
} from "@/features/admin/console/primitives";
import { spamSettingsQueryOptions } from "./mail-admin-api";
import { DecisionModelReportPanel } from "./mail-decision-model-report";
import { DecisionModelSettings } from "./mail-decision-model-settings";
import { DECISION_PROVIDER_LABELS } from "./mail-decision-model-form";

const MODE_LABELS = { off: "Off", shadow: "Shadow", enforce: "Enforce" } as const;

export function SpamFiltering() {
  const spamQuery = useQuery(spamSettingsQueryOptions());
  const settings = spamQuery.data;

  return (
    <div className="admin-stack">
      <section aria-labelledby="mail-spam-status-heading">
        <PanelHeading
          id="mail-spam-status-heading"
          title="Spam filtering"
          subtitle="SpamAssassin scores every message; an optional AI model gives a second opinion."
        />

        {spamQuery.isPending ? <LoadingState label="Loading spam settings…" /> : null}
        {spamQuery.isError ? (
          <ErrorNotice>
            Spam settings could not be loaded. You may not have permission to manage mail.{" "}
            {spamQuery.error.message}
          </ErrorNotice>
        ) : null}

        {settings ? (
          <>
            <div className="panel p-4 mb-3 flex items-center gap-3">
              <span className="text-muted-foreground">
                <ShieldIcon size={16} aria-hidden="true" />
              </span>
              <div className="flex-1">
                <div className="type-body font-semibold">SpamAssassin</div>
                <div className="type-meta [color:var(--text-2)]">
                  {settings.enabled
                    ? `Ruleset ${settings.rulesetVersion ?? "as installed"}`
                    : "SpamAssassin is not configured for this deployment."}
                </div>
              </div>
              <StatusChip
                tone={settings.enabled ? "success" : "warning"}
                label={settings.enabled ? "Filtering on" : "Filtering off"}
              />
              <StatusChip
                tone={settings.daemonStatus === "running" ? "success" : "danger"}
                label={settings.daemonStatus}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="panel p-4">
                <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                  Spam threshold
                </span>
                <div className="type-h1 font-bold mt-2">{settings.threshold.toFixed(1)}</div>
                <div className="type-caption text-muted-foreground mt-1">
                  {settings.rejectThreshold === null
                    ? "Score above which mail is filed in Spam; nothing is rejected outright"
                    : `Score above which mail is filed in Spam; rejected above ${settings.rejectThreshold.toFixed(1)}`}
                </div>
              </div>
              <div className="panel p-4">
                <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                  Tagged (24h)
                </span>
                <div className="type-h1 font-bold mt-2">{formatCount(settings.taggedLast24h)}</div>
                <div className="type-caption text-muted-foreground mt-1">
                  Messages filed in Spam automatically in the last day
                </div>
              </div>
              <div className="panel p-4">
                <span className="type-caption text-muted-foreground font-semibold uppercase [letter-spacing:.06em]">
                  AI second opinion
                </span>
                <div className="type-h1 font-bold mt-2">
                  {MODE_LABELS[settings.decisionModel.mode]}
                </div>
                <div className="type-caption text-muted-foreground mt-1">
                  {settings.decisionModel.mode === "off"
                    ? "AI decision model is off"
                    : `${DECISION_PROVIDER_LABELS[settings.decisionModel.provider]} · ${settings.decisionModel.model}`}
                  {settings.betaSecondPass.enabled
                    ? ` · AI spam beta on${settings.betaSecondPass.model === null ? "" : ` (${settings.betaSecondPass.model})`}`
                    : ""}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <DecisionModelSettings />
      <DecisionModelReportPanel />
    </div>
  );
}
