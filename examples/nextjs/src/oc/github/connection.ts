// GitHub as a GitHub App: connecting installs the app on the user's account (or an org they
// administer) and the connection acts as the app there. `connectd dev` creates the app for you
// from a manifest (the "github app" link it prints), since GitHub has no dynamic client registration.
export { githubApp as default } from "@connectd/providers";
