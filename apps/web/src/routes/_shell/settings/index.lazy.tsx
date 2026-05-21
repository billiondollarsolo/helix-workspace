import { createLazyFileRoute } from "@tanstack/react-router";
import { Bell, Building2, Keyboard, MonitorCog, UserRound } from "lucide-react";
import { useColorMode, useWebPlatformHost } from "@helix/sdk-web";
import { Button } from "@/components/ui/button";

export const Route = createLazyFileRoute("/_shell/settings/")({
  component: SettingsRoute,
});

function SettingsRoute() {
  const host = useWebPlatformHost();
  const actor = host.useActor();
  const colorMode = useColorMode();

  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <header className="settings-header">
        <div>
          <p className="settings-kicker">Settings</p>
          <h1 id="settings-title">Preferences</h1>
          <p>Personal and workspace defaults for how Helix feels day to day.</p>
        </div>
      </header>

      <section className="settings-grid" aria-label="Settings sections">
        <article className="settings-panel">
          <header>
            <UserRound aria-hidden="true" size={19} />
            <div>
              <h2>Account</h2>
              <p>{actor.email}</p>
            </div>
          </header>
          <dl className="settings-facts">
            <div>
              <dt>Name</dt>
              <dd>{actor.displayName}</dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd>{actor.roles.length > 0 ? actor.roles.join(", ") : "Member"}</dd>
            </div>
          </dl>
        </article>

        <article className="settings-panel">
          <header>
            <MonitorCog aria-hidden="true" size={19} />
            <div>
              <h2>Appearance</h2>
              <p>Use the global theme tokens with your preferred color mode.</p>
            </div>
          </header>
          <div className="settings-segmented" role="group" aria-label="Color mode">
            {(["light", "dark", "system"] as const).map((mode) => (
              <Button
                aria-pressed={colorMode.mode === mode}
                key={mode}
                onClick={() => colorMode.setMode(mode)}
                type="button"
                variant={colorMode.mode === mode ? "default" : "outline"}
              >
                {modeLabel(mode)}
              </Button>
            ))}
          </div>
        </article>

        <article className="settings-panel">
          <header>
            <Bell aria-hidden="true" size={19} />
            <div>
              <h2>Notifications</h2>
              <p>Personal notification defaults for mail, chat, calendar, and admin alerts.</p>
            </div>
          </header>
          <p className="settings-muted">Detailed notification controls will live here.</p>
        </article>

        <article className="settings-panel">
          <header>
            <Keyboard aria-hidden="true" size={19} />
            <div>
              <h2>Shortcuts and density</h2>
              <p>Keyboard shortcuts, list density, locale, and timezone preferences.</p>
            </div>
          </header>
          <p className="settings-muted">Workspace apps inherit these personal defaults.</p>
        </article>

        <article className="settings-panel">
          <header>
            <Building2 aria-hidden="true" size={19} />
            <div>
              <h2>Workspace preferences</h2>
              <p>Display name, branding defaults, and non-dangerous workspace metadata.</p>
            </div>
          </header>
          <p className="settings-muted">Operational controls have moved to Admin.</p>
        </article>
      </section>
    </main>
  );
}

function modeLabel(mode: "light" | "dark" | "system"): string {
  if (mode === "light") {
    return "Light";
  }
  if (mode === "dark") {
    return "Dark";
  }
  return "System";
}
