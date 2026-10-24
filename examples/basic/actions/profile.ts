import { action } from "@openconnect/connections";
import { github } from "@openconnect/providers";

// `POST /connections/github/:id/actions/profile` (`oc.connection("github", id).actions.profile()`):
// the connected user's GitHub profile, through the connection's authenticated api. Found by folder discovery.
export const profile = action("profile", github).run(async ({ api }) => {
  const me = await api.get<{ login: string; public_repos: number }>("/user");
  return { login: me.login, repos: me.public_repos };
});
