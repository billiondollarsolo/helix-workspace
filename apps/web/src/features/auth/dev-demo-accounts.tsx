/* One-click sign-in for the seeded local demo accounts. Development builds
   only: production builds replace it with nothing, so the demo credentials
   never ship. */

import type { ReactNode } from "react";

interface DemoAccount {
  readonly label: string;
  readonly email: string;
  readonly password: string;
}

const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { label: "Admin", email: "admin@helix.local", password: "helix-admin-password" },
  { label: "Member", email: "user@helix.local", password: "helix-user-password" },
];

interface DevDemoAccountsProps {
  readonly disabled: boolean;
  readonly onUse: (account: DemoAccount) => void;
}

function DemoAccounts({ disabled, onUse }: DevDemoAccountsProps) {
  return (
    <div className="auth-demo">
      <span className="auth-demo-label" id="auth-demo-label">
        Development sign-in
      </span>
      <div className="auth-demo-row" role="group" aria-labelledby="auth-demo-label">
        {DEMO_ACCOUNTS.map((account) => (
          <button
            key={account.email}
            type="button"
            className="btn sm"
            disabled={disabled}
            onClick={() => onUse(account)}
          >
            {account.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export const DevDemoAccounts: (props: DevDemoAccountsProps) => ReactNode = import.meta.env.DEV
  ? DemoAccounts
  : () => null;
