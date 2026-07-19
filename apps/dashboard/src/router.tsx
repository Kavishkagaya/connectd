import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { ApiKeysPage } from "./routes/api-keys";
import { ConnectionsPage } from "./routes/connections";
import { ConnectorsPage } from "./routes/connectors";
import { RootLayout } from "./routes/root";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  loader: () => {
    throw redirect({ to: "/connectors" });
  },
});

const connectorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connectors",
  component: ConnectorsPage,
});

const apiKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-keys",
  component: ApiKeysPage,
});

const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  component: ConnectionsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  connectorsRoute,
  apiKeysRoute,
  connectionsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  // biome-ignore lint/nursery/useConsistentTypeDefinitions: must stay an interface — TanStack Router's module augmentation relies on declaration merging, which `type` can't do
  interface Register {
    router: typeof router;
  }
}
