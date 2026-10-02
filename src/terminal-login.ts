import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { atomicJson } from "./files.ts";
import { journalApiUrl, parseJournalPage } from "./journal.ts";
import { DownloadError, origin } from "./model.ts";
import { SessionCookies } from "./session.ts";

const loginFailure =
  "Sign-in was not completed. Check your credentials on KinderCare's website, and complete any required verification there.";

// The observed Rails form uses an ASCII/base64 CSRF token. Fail closed if it changes.
export function loginToken(html: string) {
  const tokens: string[] = [];
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of input[0].matchAll(
      /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/g,
    )) {
      if (attr[1]) {
        attributes.set(
          attr[1].toLowerCase(),
          attr[2] ?? attr[3] ?? attr[4] ?? "",
        );
      }
    }
    if (attributes.get("name") === "authenticity_token") {
      const value = attributes.get("value") ?? "";
      if (/^[A-Za-z0-9+/_=-]{16,1024}$/.test(value)) {
        tokens.push(value);
      }
    }
  }
  if (tokens.length !== 1 || !tokens[0]) {
    throw new DownloadError(
      "KinderCare's login form is not recognized. The login adapter needs an update.",
    );
  }
  return tokens[0];
}

export async function authenticate(
  username: string,
  password: string,
  destination: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const endpoint = journalApiUrl(destination);
  const session = new SessionCookies();
  async function send(url: string, body?: URLSearchParams) {
    // Credentials and cookies never follow redirects or leave the classroom origin.
    if (new URL(url).origin !== origin) {
      throw new DownloadError(loginFailure);
    }
    const headers = new Headers({
      Cookie: (await session.cookies(url))
        .map((c) => `${c.name}=${c.value}`)
        .join("; "),
    });
    if (body) {
      headers.set("Origin", origin);
      headers.set("Referer", `${origin}/login`);
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    }
    const response = await request(url, {
      method: body ? "POST" : "GET",
      headers,
      redirect: "manual",
      ...(body ? { body } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    await session.receiveCookies(url, response.headers);
    if (response.status === 429) {
      await response.body?.cancel();
      throw new DownloadError(
        "KinderCare is rate limiting sign-in. Wait before trying again.",
      );
    }
    return response;
  }
  const form = await send(`${origin}/login`);
  if (
    form.status !== 200 ||
    !form.headers.get("content-type")?.includes("text/html")
  ) {
    await form.body?.cancel();
    throw new DownloadError(loginFailure);
  }
  const token = loginToken(await form.text());
  const response = await send(
    `${origin}/login`,
    new URLSearchParams({
      authenticity_token: token,
      "user[login]": username,
      "user[password]": password,
      "user[remember_me]": "1",
      commit: "Log in",
    }),
  );
  await response.body?.cancel();
  if (![200, 302, 303].includes(response.status)) {
    throw new DownloadError(loginFailure);
  }
  // Do not trust a redirect as evidence of login. Verify parent API access directly.
  const journal = await send(`${endpoint}?page=1`);
  if (
    journal.status !== 200 ||
    !journal.headers.get("content-type")?.includes("application/json")
  ) {
    await journal.body?.cancel();
    throw new DownloadError(loginFailure);
  }
  const page = parseJournalPage(await journal.json());
  if (page.page !== 1) {
    throw new DownloadError(loginFailure);
  }
  return session;
}

function hiddenPassword(signal: AbortSignal): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new DownloadError(
      "Login requires an interactive terminal. Do not pipe passwords or put them in command arguments.",
    );
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin);
    const finish = (error?: Error) => {
      stdin.off("keypress", keypress);
      stdin.off("end", ended);
      stdin.off("error", ended);
      signal.removeEventListener("abort", aborted);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
      value = "";
    };
    const aborted = () => finish(new DownloadError("Login cancelled."));
    const ended = () =>
      finish(new DownloadError("Terminal input ended. Login cancelled."));
    const keypress = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && ["c", "d"].includes(key.name ?? "")) {
        aborted();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (key.ctrl && key.name === "u") {
        value = "";
        return;
      }
      if (
        text &&
        !key.ctrl &&
        !key.meta &&
        Array.from(text).every(
          (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
        )
      ) {
        value += text;
      }
    };
    stdin.on("keypress", keypress);
    stdin.once("end", ended);
    stdin.once("error", ended);
    signal.addEventListener("abort", aborted, { once: true });
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("Password (hidden): ");
  });
}

export async function terminalLogin(
  authPath: string,
  configPath: string,
  destination: string,
  signal: AbortSignal,
) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new DownloadError("Login requires an interactive terminal.");
  }
  const input = createInterface({ input: stdin, output: stdout });
  let username: string;
  try {
    username = (
      await input.question("KinderCare email or username: ", { signal })
    ).trim();
  } finally {
    input.close();
  }
  if (!username) {
    throw new DownloadError("A login name is required.");
  }
  let password = await hiddenPassword(signal);
  if (!password) {
    throw new DownloadError("A password is required.");
  }
  try {
    const session = await authenticate(username, password, destination, signal);
    await atomicJson(authPath, session.toJSON());
    await atomicJson(configPath, { journalUrl: destination });
    console.info(
      "Login verified and saved locally. Run sync to download the journal.",
    );
  } finally {
    password = "";
  }
}
