import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import {
  fetchOnboardingState,
  saveOnboardingProgress,
  sendOnboardingEvent,
  sendOnboardingInvites,
  type FetchOnboardingState,
  type SaveOnboardingProgress,
  type SaveOnboardingProgressInput,
  type SendOnboardingInvites,
  type SendOnboardingEvent,
  type SendOnboardingEventInput,
} from "./api";

type OnboardingStep = "plan" | "invite" | "sso";
type PlanChoice = "pro-trial" | "personal" | "sales";
type SsoProvider = "google" | "microsoft" | "okta" | "oidc" | "saml";
type IdentityChoice = "local" | SsoProvider;

const steps: ReadonlyArray<{ readonly id: OnboardingStep; readonly label: string }> = [
  { id: "plan", label: "Plan" },
  { id: "invite", label: "Invite" },
  { id: "sso", label: "Sign-in" },
];

const ssoChoices: ReadonlyArray<{
  readonly id: SsoProvider;
  readonly label: string;
  readonly meta: string;
}> = [
  { id: "google", label: "Google SSO", meta: "Basic SSO" },
  { id: "microsoft", label: "Microsoft SSO", meta: "Basic SSO" },
  { id: "okta", label: "Okta SSO", meta: "Business SSO" },
  { id: "oidc", label: "OIDC", meta: "Business SSO" },
  { id: "saml", label: "SAML", meta: "Business SSO" },
];

export interface OnboardingShellProps {
  readonly fetchState?: FetchOnboardingState;
  readonly sendEvent?: SendOnboardingEvent;
  readonly sendInvites?: SendOnboardingInvites;
  readonly saveProgress?: SaveOnboardingProgress;
}

export function OnboardingShell({
  fetchState = fetchOnboardingState,
  sendEvent = sendOnboardingEvent,
  sendInvites = sendOnboardingInvites,
  saveProgress = saveOnboardingProgress,
}: OnboardingShellProps = {}) {
  const [step, setStep] = useState<OnboardingStep>("plan");
  const [plan, setPlan] = useState<PlanChoice>("pro-trial");
  const [inviteEmails, setInviteEmails] = useState("");
  const [savedInviteCount, setSavedInviteCount] = useState(0);
  const [identityChoice, setIdentityChoice] = useState<IdentityChoice>("local");
  const sentInviteBatch = useRef<string | null>(null);
  const stepIndex = steps.findIndex((candidate) => candidate.id === step);
  const inviteRecipients = useMemo(() => parseInviteEmails(inviteEmails), [inviteEmails]);
  const inviteCount = inviteRecipients.length;
  const effectiveInviteCount = inviteCount > 0 ? inviteCount : savedInviteCount;
  const availableSsoChoices = useMemo(() => ssoChoicesForPlan(plan), [plan]);

  useEffect(() => {
    let active = true;
    void fetchState()
      .then((state) => {
        if (!active || state.status === "not_started") {
          return;
        }
        setStep(state.currentStep);
        setPlan(state.planChoice);
        setSavedInviteCount(state.inviteCount);
        setIdentityChoice(identityChoiceForPlan(state.planChoice, state.identityChoice));
      })
      .catch(() => undefined);
    void sendEvent({ event: "started" }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [fetchState, sendEvent]);

  function nextStep(): void {
    if (step === "invite") {
      recordInvites();
    }
    const next = steps[Math.min(stepIndex + 1, steps.length - 1)]?.id ?? "sso";
    setStep(next);
    recordProgress({ currentStep: next });
  }

  function completedEvent(skipped: boolean): SendOnboardingEventInput {
    return {
      event: "completed",
      planChoice: plan,
      inviteCount: Math.min(effectiveInviteCount, 10),
      identityChoice,
      skipped,
    };
  }

  function recordCompleted(skipped: boolean): void {
    if (!skipped) {
      recordInvites();
    }
    void sendEvent(completedEvent(skipped)).catch(() => undefined);
  }

  function recordProgress(input: Pick<SaveOnboardingProgressInput, "currentStep">): void {
    void saveProgress({
      currentStep: input.currentStep,
      planChoice: plan,
      inviteCount: Math.min(effectiveInviteCount, 10),
      identityChoice,
    }).catch(() => undefined);
  }

  function choosePlan(nextPlan: PlanChoice): void {
    const nextIdentityChoice = identityChoiceForPlan(nextPlan, identityChoice);
    setPlan(nextPlan);
    setIdentityChoice(nextIdentityChoice);
    void saveProgress({
      currentStep: step,
      planChoice: nextPlan,
      inviteCount: Math.min(effectiveInviteCount, 10),
      identityChoice: nextIdentityChoice,
    }).catch(() => undefined);
  }

  function chooseIdentity(nextIdentityChoice: IdentityChoice): void {
    if (!isIdentityChoiceAllowedForPlan(plan, nextIdentityChoice)) {
      return;
    }
    setIdentityChoice(nextIdentityChoice);
    void saveProgress({
      currentStep: step,
      planChoice: plan,
      inviteCount: Math.min(effectiveInviteCount, 10),
      identityChoice: nextIdentityChoice,
    }).catch(() => undefined);
  }

  function recordInvites(): void {
    if (inviteRecipients.length === 0) {
      return;
    }
    const key = inviteRecipients.join("\n");
    if (sentInviteBatch.current === key) {
      return;
    }
    sentInviteBatch.current = key;
    setSavedInviteCount(inviteRecipients.length);
    void sendInvites({ emails: inviteRecipients }).catch(() => {
      sentInviteBatch.current = null;
    });
  }

  return (
    <SurfaceFrame title="Onboarding" icon={<Icons.Check />} searchPlaceholder="Search workspace">
      <div className="onboarding-surface">
        <header className="onboarding-header">
          <div>
            <p className="surface-kicker">Workspace setup</p>
            <h1>Finish your Helix workspace</h1>
          </div>
          <Link className="btn ghost" to="/welcome" onClick={() => recordCompleted(true)}>
            Skip
          </Link>
        </header>

        <nav className="onboarding-steps" aria-label="Onboarding steps">
          {steps.map((candidate, index) => (
            <button
              key={candidate.id}
              className={candidate.id === step ? "onboarding-step active" : "onboarding-step"}
              type="button"
              onClick={() => {
                setStep(candidate.id);
                recordProgress({ currentStep: candidate.id });
              }}
            >
              <span>{index + 1}</span>
              {candidate.label}
            </button>
          ))}
        </nav>

        {step === "plan" ? (
          <section className="onboarding-panel" aria-labelledby="onboarding-plan-title">
            <div className="onboarding-panel-head">
              <Icons.Credit />
              <div>
                <h2 id="onboarding-plan-title">Choose a starting plan</h2>
                <p>Start with the trial, stay free, or route Enterprise to sales.</p>
              </div>
            </div>
            <div className="onboarding-options">
              <OptionButton
                active={plan === "pro-trial"}
                label="14-day Pro trial"
                meta="No card required"
                onClick={() => choosePlan("pro-trial")}
              />
              <OptionButton
                active={plan === "personal"}
                label="Personal free tier"
                meta="Single-user workspace"
                onClick={() => choosePlan("personal")}
              />
              <OptionButton
                active={plan === "sales"}
                label="Talk to sales"
                meta="Enterprise planning"
                onClick={() => choosePlan("sales")}
              />
            </div>
            <button className="btn primary onboarding-next" type="button" onClick={nextStep}>
              Continue
              <ArrowRight aria-hidden="true" />
            </button>
          </section>
        ) : null}

        {step === "invite" ? (
          <section className="onboarding-panel" aria-labelledby="onboarding-invite-title">
            <div className="onboarding-panel-head">
              <Icons.Users />
              <div>
                <h2 id="onboarding-invite-title">Invite teammates</h2>
                <p>Paste up to 10 email addresses. Invitations can also wait.</p>
              </div>
            </div>
            <label className="onboarding-field">
              <span>Team emails</span>
              <textarea
                value={inviteEmails}
                onChange={(event) => setInviteEmails(event.target.value)}
                placeholder="ada@example.com, grace@example.com"
                rows={5}
              />
            </label>
            <p className="onboarding-status" role="status">
              {inviteCount === 0
                ? savedInviteCount > 0
                  ? `${String(savedInviteCount)} invitation${savedInviteCount === 1 ? "" : "s"} sent.`
                  : "No invitations queued."
                : `${String(Math.min(inviteCount, 10))} invitation${inviteCount === 1 ? "" : "s"} queued.`}
            </p>
            <button className="btn primary onboarding-next" type="button" onClick={nextStep}>
              Continue
              <ArrowRight aria-hidden="true" />
            </button>
          </section>
        ) : null}

        {step === "sso" ? (
          <section className="onboarding-panel" aria-labelledby="onboarding-sso-title">
            <div className="onboarding-panel-head">
              <Icons.Shield />
              <div>
                <h2 id="onboarding-sso-title">Choose sign-in method</h2>
                <p>Use local email/password by default. Add SSO now, or return to it later.</p>
              </div>
            </div>
            <div className="onboarding-options compact">
              <OptionButton
                active={identityChoice === "local"}
                label="Local email/password login"
                meta="Built-in login for owners, admins, and members"
                onClick={() => chooseIdentity("local")}
              />
              {availableSsoChoices.map((choice) => (
                <OptionButton
                  key={choice.id}
                  active={choice.id === identityChoice}
                  label={choice.label}
                  meta={choice.meta}
                  onClick={() => chooseIdentity(choice.id)}
                />
              ))}
            </div>
            {availableSsoChoices.length === 0 ? (
              <p className="onboarding-status" role="status">
                SSO setup is available after upgrading to a team plan.
              </p>
            ) : null}
            <Link
              className="btn primary onboarding-next"
              to="/welcome"
              onClick={() => recordCompleted(false)}
            >
              Finish onboarding
              <ArrowRight aria-hidden="true" />
            </Link>
          </section>
        ) : null}
      </div>
    </SurfaceFrame>
  );
}

function ssoChoicesForPlan(plan: PlanChoice): readonly (typeof ssoChoices)[number][] {
  if (plan === "personal") {
    return [];
  }
  if (plan === "pro-trial") {
    return ssoChoices.filter((choice) => choice.id === "google" || choice.id === "microsoft");
  }
  return ssoChoices;
}

function isIdentityChoiceAllowedForPlan(plan: PlanChoice, identity: IdentityChoice): boolean {
  return identity === "local" || ssoChoicesForPlan(plan).some((choice) => choice.id === identity);
}

function identityChoiceForPlan(plan: PlanChoice, identity: IdentityChoice): IdentityChoice {
  return isIdentityChoiceAllowedForPlan(plan, identity) ? identity : "local";
}

function parseInviteEmails(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/u)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.includes("@")),
    ),
  ].slice(0, 10);
}

function OptionButton({
  active,
  label,
  meta,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly meta: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      className={active ? "onboarding-option active" : "onboarding-option"}
      type="button"
      onClick={onClick}
    >
      <span>
        <strong>{label}</strong>
        <small>{meta}</small>
      </span>
      {active ? <CheckCircle2 aria-hidden="true" /> : null}
    </button>
  );
}
