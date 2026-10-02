import { setTimeout } from "node:timers/promises";
import { DownloadError, origin } from "./model.ts";

export type GetResponse = (url: string) => Promise<Response>;

interface CookieSession {
  cookies(url: string): Promise<{ name: string; value: string }[]>;
  receiveCookies?(url: string, headers: Headers): Promise<void>;
}

export function allowedMediaUrl(value: string) {
  const url = new URL(value);
  const allowed = [
    "kindercare.com",
    "himama.com",
    "lillio.com",
    "amazonaws.com",
    "cloudfront.net",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !allowed.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new DownloadError(
      "KinderCare redirected to an unrecognized media host. The downloader needs an adapter update.",
    );
  }
  return url;
}

export function createGetResponse(
  context: CookieSession,
  signal?: AbortSignal,
): GetResponse {
  return async (value) => {
    const url = allowedMediaUrl(value);
    const headers: Record<string, string> = {};
    // Auth is sent only to KinderCare, never forwarded to a media CDN redirect.
    if (url.origin === origin) {
      headers.Cookie = (await context.cookies(url.href))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
    }
    try {
      const response = await fetch(url, {
        headers,
        redirect: "manual",
        signal: AbortSignal.any([
          AbortSignal.timeout(180_000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (url.origin === origin) {
        await context.receiveCookies?.(url.href, response.headers);
      }
      return response;
    } catch {
      throw new DownloadError(
        "A network request failed or timed out. Re-run sync to resume.",
      );
    }
  };
}

function retryDelay(header: string | null, attempt: number) {
  const seconds = Number(header);
  const requested =
    header === null
      ? 0
      : Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(header) - Date.now();
  return Math.max(
    1000 * 2 ** attempt,
    Number.isFinite(requested) ? requested : 0,
  );
}

type Pause = (milliseconds: number, signal?: AbortSignal) => Promise<unknown>;
const sleep: Pause = (milliseconds, signal) =>
  setTimeout(milliseconds, undefined, { signal });

// Only GET requests are retried. Login submissions must never use this helper.
export async function getWithRetry(
  url: string,
  get: GetResponse,
  signal?: AbortSignal,
  pause: Pause = sleep,
) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await get(url);
    if (response.status !== 429 && response.status < 500) {
      return response;
    }
    const delay = retryDelay(response.headers.get("retry-after"), attempt);
    await response.body?.cancel();
    if (delay > 60_000) {
      throw new DownloadError(
        `KinderCare requested a longer pause. Try sync again in at least ${Math.ceil(delay / 1000)} seconds.`,
      );
    }
    if (attempt === 3) {
      throw new DownloadError(
        "KinderCare is busy or rate limiting downloads. Try sync again later.",
      );
    }
    await pause(delay, signal);
  }
}

export async function mediaResponse(
  url: string,
  get: GetResponse,
  pause: Pause = sleep,
  signal?: AbortSignal,
) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await getWithRetry(current, get, signal, pause);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new DownloadError("The media redirect had no destination.");
      }
      current = allowedMediaUrl(new URL(location, current).href).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError(
        `Media request failed (HTTP ${response.status}). Re-run sync; if needed, run login again.`,
      );
    }
    return response;
  }
  throw new DownloadError(
    "The media request redirected too many times. Run login again.",
  );
}
