import { useAsyncDebouncedCallback } from "@tanstack/react-pacer/async-debouncer";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Dna, Loader2, MailCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  checkOrgSlugAvailability,
  recordSignupFormViewed,
  signupFormViewedInputFromBrowser,
  startSignup,
  type SignupResponse,
} from "./api";
import {
  evaluateSignupPasswordStrength,
  preloadSignupPasswordStrengthEstimator,
  type SignupPasswordStrength,
} from "./password-strength";
import { defaultSignupRecaptchaExecutor, type SignupRecaptchaExecutor } from "./recaptcha";

type SignupStatus = "idle" | "submitting" | "submitted";
type SlugStatus =
  | { readonly state: "idle" }
  | { readonly state: "checking" }
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "error"; readonly message: string };

interface SignupShellProps {
  readonly fetchImpl?: typeof fetch;
  readonly recaptcha?: SignupRecaptchaExecutor | undefined;
}

export function SignupShell({
  fetchImpl = fetch,
  recaptcha = defaultSignupRecaptchaExecutor(),
}: SignupShellProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [country, setCountry] = useState("");
  const [phone, setPhone] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugStatus, setSlugStatus] = useState<SlugStatus>({ state: "idle" });
  const [status, setStatus] = useState<SignupStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResponse | null>(null);
  const [passwordStrength, setPasswordStrength] = useState<SignupPasswordStrength | null>(null);
  const slugCheckSeq = useRef(0);
  const passwordStrengthSeq = useRef(0);
  const formViewedRecorded = useRef(false);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  const checkSlug = useAsyncDebouncedCallback(
    async (slug: string, seq: number) => {
      try {
        const availability = await checkOrgSlugAvailability(slug, fetchImpl);
        if (seq !== slugCheckSeq.current) {
          return;
        }
        if (!availability.valid || !availability.available) {
          setSlugStatus({
            state: "unavailable",
            reason: availabilityReason(availability.reason),
          });
          return;
        }
        setSlugStatus({ state: "available" });
      } catch (caught) {
        if (seq !== slugCheckSeq.current) {
          return;
        }
        setSlugStatus({
          state: "error",
          message:
            caught instanceof Error
              ? caught.message
              : "Workspace URL availability could not be checked.",
        });
      }
    },
    { wait: 300 },
  );

  useEffect(() => {
    const seq = passwordStrengthSeq.current + 1;
    passwordStrengthSeq.current = seq;
    setPasswordStrength(null);
    void evaluateSignupPasswordStrength({
      password,
      email,
      orgName,
    })
      .then((strength) => {
        if (seq === passwordStrengthSeq.current) {
          setPasswordStrength(strength);
        }
      })
      .catch(() => {
        if (seq === passwordStrengthSeq.current) {
          setPasswordStrength({
            score: 0,
            acceptable: false,
            label: "Password strength could not be checked. Change the password to retry.",
          });
        }
      });
  }, [email, orgName, password]);

  useEffect(() => {
    if (formViewedRecorded.current) {
      return;
    }
    formViewedRecorded.current = true;
    void recordSignupFormViewed(
      signupFormViewedInputFromBrowser({
        search: window.location.search,
        referrer: document.referrer,
      }),
      fetchImpl,
    ).catch(() => undefined);
  }, [fetchImpl]);

  useEffect(() => {
    if (slugEdited) {
      return;
    }
    setOrgSlug(deriveOrgSlug(orgName));
  }, [orgName, slugEdited]);

  useEffect(() => {
    if (orgSlug.length < 3) {
      setSlugStatus({ state: "idle" });
      return;
    }

    const seq = slugCheckSeq.current + 1;
    slugCheckSeq.current = seq;
    setSlugStatus({ state: "checking" });
    void checkSlug(orgSlug, seq);
  }, [checkSlug, orgSlug]);

  const canSubmit = useMemo(
    () =>
      status !== "submitting" &&
      email.trim().length > 0 &&
      password.length >= 12 &&
      passwordStrength?.acceptable === true &&
      orgName.trim().length > 0 &&
      orgName.trim().length <= 64 &&
      orgSlug.length >= 3 &&
      country.length === 2 &&
      termsAccepted &&
      privacyAccepted &&
      slugStatus.state !== "checking" &&
      slugStatus.state !== "unavailable",
    [
      country.length,
      email,
      orgName,
      orgSlug,
      password.length,
      passwordStrength?.acceptable,
      privacyAccepted,
      slugStatus.state,
      status,
      termsAccepted,
    ],
  );

  async function submit(): Promise<void> {
    setStatus("submitting");
    setError(null);
    try {
      const recaptchaToken = await recaptcha?.execute();
      const next = await startSignup(
        {
          email: email.trim(),
          password,
          orgName: orgName.trim(),
          orgSlug,
          country,
          ...(phone.trim().length === 0 ? {} : { phone: phone.trim() }),
          marketingOptIn,
          termsAccepted,
          privacyAccepted,
          ...(recaptchaToken === undefined ? {} : { recaptchaToken }),
        },
        fetchImpl,
      );
      setResult(next);
      setStatus("submitted");
    } catch (caught) {
      setStatus("idle");
      setError(caught instanceof Error ? caught.message : "Signup failed.");
    }
  }

  if (status === "submitted" && result !== null) {
    return (
      <main className="auth-screen">
        <section className="panel auth-panel signup-panel">
          <div className="auth-brand">
            <div className="auth-logo success" aria-hidden="true">
              <MailCheck />
            </div>
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-subtitle">
              We sent a verification link for {result.org.displayName}.
            </p>
          </div>
          <div className="auth-success" role="status">
            <CheckCircle2 aria-hidden="true" />
            <span>
              Workspace <strong>{result.org.slug}</strong> is provisioning. Verify your email to
              activate it.
            </span>
          </div>
          <Link className="btn primary lg auth-submit" to="/login">
            Sign in with email/password
            <ArrowRight aria-hidden="true" />
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <section className="panel auth-panel signup-panel">
        <div className="auth-brand">
          <div className="auth-logo" aria-hidden="true">
            <Dna />
          </div>
          <h1 className="auth-title">Create your Helix workspace</h1>
          <p className="auth-subtitle">Start with an owner account and workspace URL.</p>
        </div>

        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              void submit();
            }
          }}
        >
          <label className="auth-field">
            <span className="auth-label">Work email</span>
            <input
              className="input"
              name="email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="auth-field">
            <span className="auth-label">Password</span>
            <input
              className="input"
              name="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 12 characters"
              value={password}
              onFocus={() => {
                void preloadSignupPasswordStrengthEstimator().catch(() => undefined);
              }}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              aria-describedby="signup-password-status"
              aria-invalid={
                password.length > 0 && passwordStrength?.acceptable === false ? true : undefined
              }
              required
            />
          </label>
          <p
            id="signup-password-status"
            className={
              passwordStrength?.acceptable === true ? "auth-status success" : "auth-status"
            }
            role="status"
          >
            {passwordStrength?.label ?? "Checking password strength…"}
          </p>
          <label className="auth-field">
            <span className="auth-label">Workspace name</span>
            <input
              className="input"
              name="orgName"
              type="text"
              autoComplete="organization"
              placeholder="Acme"
              value={orgName}
              onChange={(event) => setOrgName(event.target.value)}
              maxLength={64}
              required
            />
          </label>
          <label className="auth-field">
            <span className="auth-label">Workspace URL</span>
            <input
              className="input"
              name="orgSlug"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="acme"
              value={orgSlug}
              aria-describedby="signup-slug-status"
              onChange={(event) => {
                setSlugEdited(true);
                setOrgSlug(sanitizeSlugInput(event.target.value));
              }}
              required
            />
          </label>
          <p id="signup-slug-status" className={slugStatusClassName(slugStatus)} role="status">
            {slugStatusText(orgSlug, slugStatus)}
          </p>
          <label className="auth-field">
            <span className="auth-label">Country</span>
            <select
              className="select auth-select"
              name="country"
              value={country}
              onChange={(event) => setCountry(event.target.value)}
              required
            >
              <option value="">Select country</option>
              <option value="US">United States</option>
              <option value="CA">Canada</option>
              <option value="GB">United Kingdom</option>
              <option value="AU">Australia</option>
              <option value="DE">Germany</option>
              <option value="FR">France</option>
              <option value="IN">India</option>
              <option value="JP">Japan</option>
              <option value="BR">Brazil</option>
              <option value="ZA">South Africa</option>
            </select>
          </label>
          <label className="auth-field">
            <span className="auth-label">Phone</span>
            <input
              className="input"
              name="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+1 415 555 0100"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <label className="auth-check">
            <input
              type="checkbox"
              name="marketingOptIn"
              checked={marketingOptIn}
              onChange={(event) => setMarketingOptIn(event.target.checked)}
            />
            <span>Send product updates and launch notes</span>
          </label>
          <label className="auth-check">
            <input
              type="checkbox"
              name="termsAccepted"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              required
            />
            <span>
              I accept the <a href="https://www.helix.app/legal/terms">Terms of Service</a>
            </span>
          </label>
          <label className="auth-check">
            <input
              type="checkbox"
              name="privacyAccepted"
              checked={privacyAccepted}
              onChange={(event) => setPrivacyAccepted(event.target.checked)}
              required
            />
            <span>
              I accept the <a href="https://www.helix.app/legal/privacy">Privacy Policy</a>
            </span>
          </label>

          {error === null ? null : (
            <p ref={errorRef} id="signup-error" className="auth-error" role="alert" tabIndex={-1}>
              {error}
            </p>
          )}

          <button
            className="btn primary lg auth-submit"
            type="submit"
            disabled={!canSubmit}
            aria-busy={status === "submitting"}
          >
            {status === "submitting" ? (
              <Loader2 className="auth-spinner" aria-hidden="true" />
            ) : (
              <ArrowRight aria-hidden="true" />
            )}
            {status === "submitting" ? "Creating workspace…" : "Create workspace"}
          </button>
        </form>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}

export function deriveOrgSlug(value: string): string {
  return sanitizeSlugInput(value).replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 63);
}

function sanitizeSlugInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+/u, "");
}

function slugStatusClassName(status: SlugStatus): string {
  if (status.state === "available") {
    return "auth-status success";
  }
  if (status.state === "unavailable" || status.state === "error") {
    return "auth-status danger";
  }
  return "auth-status";
}

function slugStatusText(slug: string, status: SlugStatus): string {
  if (slug.length === 0) {
    return "Choose a workspace URL.";
  }
  if (slug.length < 3) {
    return "Use at least 3 characters.";
  }
  if (status.state === "checking") {
    return "Checking availability...";
  }
  if (status.state === "available") {
    return `${slug}.helix.app is available.`;
  }
  if (status.state === "unavailable") {
    return status.reason;
  }
  if (status.state === "error") {
    return status.message;
  }
  return "Workspace URLs use lowercase letters, numbers, and hyphens.";
}

function availabilityReason(reason: SignupSlugAvailabilityReason | undefined): string {
  if (reason === "taken") {
    return "That workspace URL is already taken.";
  }
  if (reason === "reserved") {
    return "That workspace URL is reserved.";
  }
  return "Use lowercase letters, numbers, and hyphens.";
}

type SignupSlugAvailabilityReason = "invalid_format" | "reserved" | "taken";
