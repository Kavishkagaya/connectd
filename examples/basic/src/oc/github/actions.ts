import { action, actions } from "@kavishkagaya/connectd/connections";

// The github connection's actions, by name: `oc.connection("github", id).actions.profile()`.
export default actions({
  // The connected user's GitHub profile, through the connection's authenticated api.
  profile: action({
    run: async ({ api }) => {
      const me = await api.get<{ login: string; public_repos: number }>("/user");
      return { login: me.login, repos: me.public_repos };
    },
  }),
});
