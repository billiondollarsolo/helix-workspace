import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/signup")({
  component: SignupRoute
});

function SignupRoute() {
  return (
    <main className="auth-screen">
      <section>
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <h1>Create a Helix workspace</h1>
        <p>Signup will use full-page route navigation and in-app forms.</p>
        <button className="primary-action" type="button">
          Start setup
        </button>
      </section>
    </main>
  );
}
