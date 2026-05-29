export interface SignupRecaptchaExecutor {
  execute(): Promise<string | undefined>;
}

declare global {
  interface Window {
    grecaptcha?: {
      ready(callback: () => void): void;
      execute(siteKey: string, options: { readonly action: string }): Promise<string>;
    };
  }
}

export function defaultSignupRecaptchaExecutor(): SignupRecaptchaExecutor | undefined {
  const siteKey = envString("VITE_HELIX_SIGNUP_RECAPTCHA_SITE_KEY");
  if (
    siteKey === undefined ||
    siteKey.trim().length === 0 ||
    typeof window === "undefined" ||
    window.grecaptcha === undefined
  ) {
    return undefined;
  }
  return new GoogleSignupRecaptchaExecutor({
    siteKey,
    action: envString("VITE_HELIX_SIGNUP_RECAPTCHA_ACTION") ?? "signup",
  });
}

export class GoogleSignupRecaptchaExecutor implements SignupRecaptchaExecutor {
  private readonly siteKey: string;
  private readonly action: string;

  constructor(input: { readonly siteKey: string; readonly action?: string | undefined }) {
    this.siteKey = input.siteKey;
    this.action = input.action ?? "signup";
  }

  async execute(): Promise<string> {
    if (typeof window === "undefined") {
      throw new Error("Signup abuse verification is unavailable.");
    }
    const grecaptcha = window.grecaptcha;
    if (grecaptcha === undefined) {
      throw new Error("Signup abuse verification is unavailable.");
    }
    await new Promise<void>((resolve) => {
      grecaptcha.ready(resolve);
    });
    return grecaptcha.execute(this.siteKey, { action: this.action });
  }
}

function envString(key: string): string | undefined {
  const env = import.meta.env as Record<string, unknown>;
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}
