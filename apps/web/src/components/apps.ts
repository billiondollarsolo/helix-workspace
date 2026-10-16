import { type IconName } from "@/components/icon-map";
/* The Helix app registry. Drives the navigation rail, the mobile bottom bar,
   the app launcher, and the command palette. Each app has a route under the
   `_shell` layout.

   `pinned` apps are the everyday communication tools that sit in the rail and
   the mobile bottom bar; the launcher lists every app. */

export interface HelixApp {
  /** Stable id, also the route segment (`/mail`, `/calendar`, …). */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** One-line purpose, shown in the launcher. */
  readonly description: string;
  /** Icon key from the Helix icon set. */
  readonly icon: IconName;
  /** Launcher tile color, a label colour token. */
  readonly color: string;
  /** Route path under the `_shell` layout. */
  readonly route: string;
  /** Shown in the navigation rail and the mobile bottom bar. */
  readonly pinned: boolean;
}

export const APPS: readonly HelixApp[] = [
  {
    id: "mail",
    name: "Mail",
    description: "Inbox and conversations",
    icon: "Mail",
    color: "var(--label-red)",
    route: "/mail",
    pinned: true,
  },
  {
    id: "calendar",
    name: "Calendar",
    description: "Events and invitations",
    icon: "Calendar",
    color: "var(--label-orange)",
    route: "/calendar",
    pinned: true,
  },
  {
    id: "drive",
    name: "Drive",
    description: "Files and shared folders",
    icon: "Drive",
    color: "var(--label-violet)",
    route: "/drive",
    pinned: true,
  },
  {
    id: "chat",
    name: "Chat",
    description: "Spaces and direct messages",
    icon: "Chat",
    color: "var(--label-pink)",
    route: "/chat",
    pinned: true,
  },
  {
    id: "meet",
    name: "Meet",
    description: "Video calls",
    icon: "Video",
    color: "var(--label-cyan)",
    route: "/meet",
    pinned: true,
  },
  {
    id: "contacts",
    name: "Contacts",
    description: "People you email, chat and meet with",
    icon: "Users",
    color: "var(--label-blue)",
    route: "/contacts",
    pinned: false,
  },
  {
    id: "passwords",
    name: "Passwords",
    description: "Your password vault",
    icon: "Key",
    color: "var(--label-green)",
    route: "/passwords",
    pinned: true,
  },
  {
    id: "assistant",
    name: "Helix AI",
    description: "Ask about your work",
    icon: "Sparkles",
    color: "var(--label-purple)",
    route: "/assistant",
    pinned: true,
  },
  {
    id: "admin",
    name: "Admin",
    description: "Users, domains and policies",
    icon: "Shield",
    color: "var(--label-slate)",
    route: "/admin",
    pinned: false,
  },
];

/** Look up an app by its route path (exact or prefix match). */
export function appForRoute(pathname: string): HelixApp | undefined {
  return APPS.find((app) => pathname === app.route || pathname.startsWith(`${app.route}/`));
}
