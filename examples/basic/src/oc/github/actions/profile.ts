import { action } from "@kavishkagaya/connectd-connections";

// `oc.connection("github", id).actions.profile()`: the connected user's GitHub profile, through the
// connection's authenticated api. The file's name is the action's, the folder its connection.
export default action({
  run: async ({ api }) => {
    const me = await api.get<{ login: string; public_repos: number }>("/user");
    return { login: me.login, repos: me.public_repos };
  },
});
