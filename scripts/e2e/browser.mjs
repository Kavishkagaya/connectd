// The dashboard in a real Chrome: a CLI sign-in link, the first account (password), the
// connections and the CLI's keys on their pages, sign out and back in, and no CSP violation.
// `node browser.mjs <link> <playwright or playwright-core index.mjs> [chrome path]`
const [link, playwright, chrome] = process.argv.slice(2);
const { chromium } = await import(playwright);
const b = await chromium.launch(chrome ? { executablePath: chrome } : {});
const page = await b.newPage();
const problems = [];
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(String(e)));
let failed = 0;
const check = (name, ok, info = "") => (console.log(ok ? "PASS" : "FAIL", name, ok ? "" : info), ok || failed++);
try {
  await page.goto(link);
  await page.waitForSelector("text=Create the first account");
  check("dashboard: the CLI link signs in and asks for an account", true);
  await page.fill("#new-username", "ann");
  await page.click('role=tab[name="Password"]');
  await page.fill("#new-password", "correct horse battery");
  await page.click('button:text-is("Create account")');
  await page.waitForSelector('h1:text-is("Connections")');
  check("dashboard: the connection is listed", (await page.textContent("body")).includes("alice"));
  await page.goto(new URL("/dashboard#/keys", link).href);
  await page.waitForSelector("text=New key");
  const body = await page.textContent("body");
  check("dashboard: the keys the CLI made are listed", body.includes("ock_") && body.includes("app"));
  await page.click('button:has-text("ann")');
  await page.click("text=Sign out");
  await page.waitForSelector("#password");
  await page.fill("#username", "ann");
  await page.fill("#password", "correct horse battery");
  await page.click("text=Sign in with password");
  await page.waitForSelector('button:has-text("ann")');
  check("dashboard: back in with the password", true);
  check("dashboard: no CSP violation or page error", problems.length === 0, problems.join("; "));
} catch (e) {
  check(String(e).split("\n")[0], false);
} finally {
  await b.close();
}
process.exit(failed ? 1 : 0);
