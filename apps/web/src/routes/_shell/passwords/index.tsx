import { createFileRoute } from "@tanstack/react-router";
import { PasswordsPage } from "@/features/passwords/passwords-page";

export const Route = createFileRoute("/_shell/passwords/")({
  component: PasswordsPage,
});
