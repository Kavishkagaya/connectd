// The bundle's entry (build.ts): the dashboard on the page it's loaded into.
import { setNonce } from "get-nonce";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// The page's CSP nonce, for the <style> tags the UI library adds (a dialog's scroll lock).
const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute("content");
if (nonce) setNonce(nonce);

createRoot(document.getElementById("app") as HTMLElement).render(<App />);
