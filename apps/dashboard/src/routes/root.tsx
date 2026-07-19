import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/clerk-react";
import { Link, Outlet } from "@tanstack/react-router";

export function RootLayout() {
  return (
    <div>
      <header>
        <nav>
          <Link to="/connectors">Connectors</Link>
          <Link to="/api-keys">API Keys</Link>
          <Link to="/connections">Connections</Link>
        </nav>
        <SignedIn>
          <UserButton />
        </SignedIn>
        <SignedOut>
          <SignInButton />
        </SignedOut>
      </header>
      <main>
        <SignedIn>
          <Outlet />
        </SignedIn>
        <SignedOut>
          <p>Sign in to manage your connectors.</p>
        </SignedOut>
      </main>
    </div>
  );
}
