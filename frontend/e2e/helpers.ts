import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mailpit = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8026";

/** A fresh address per run, so the per-address rate limit never bites. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@ourcalendar.test`;
}

export function createUser(email: string, name: string, admin = false): void {
  const target = admin ? "create-admin" : "create-user";
  execFileSync("make", ["-s", target, `EMAIL=${email}`, `NAME=${name}`], {
    cwd: repoRoot,
    stdio: "pipe",
  });
}

type MailSummary = { ID: string };

/** The sign-in link from the newest mail to `email`, waiting for it to arrive. */
export async function magicLink(email: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = (await res.json()) as { messages: MailSummary[] };
    if (messages.length > 0) {
      const msg = await (await fetch(`${mailpit}/api/v1/message/${messages[0]!.ID}`)).json();
      const link = /https:\/\/\S+\/auth\/verify#t=\S+/.exec((msg as { Text: string }).Text);
      if (link) return link[0];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in mail for ${email}`);
}

/** Sign in through the UI and the emailed link (users from the CLI have no password). Leaves the
 *  page on wherever sign-in lands. */
export async function signIn(page: import("@playwright/test").Page, email: string): Promise<void> {
  await page.goto("/signin");
  await page.locator("main button.link").click(); // "email me a sign-in link instead"
  await page.getByRole("textbox").fill(email);
  await page.locator("form button[type=submit]").click();
  await page.getByRole("status").waitFor();
  await page.goto(await magicLink(email));
  await page.locator("main button").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));
}
