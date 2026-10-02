import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { type GetResponse, getWithRetry } from "./http.ts";
import {
  DownloadError,
  journalDateSchema,
  type Media,
  mediaKey,
  mediaSchema,
  origin,
} from "./model.ts";

const activitySchema = z.object({
  activity: z.object({
    id: mediaSchema.shape.id.or(z.number().int().positive()).transform(String),
    list_date: journalDateSchema.nullish(),
    created_at: journalDateSchema.nullish(),
    image: z.object({ url: z.string().nullable() }),
    video: z.object({ url: z.string().nullable() }),
  }),
});

const intervalSchema = z.union([
  z.array(activitySchema),
  z.record(z.string(), activitySchema),
]);

const journalPageSchema = z.object({
  page: z.coerce.number().int().positive(),
  intervals: z.record(z.string(), intervalSchema),
});

export function parseJournalPage(value: unknown) {
  const result = journalPageSchema.safeParse(value);
  if (!result.success) {
    throw new DownloadError(
      "KinderCare's journal format is not recognized. The adapter needs an update.",
    );
  }
  return result.data;
}

export async function* collectJournalPages(
  getPage: (number: number) => Promise<unknown>,
  maxPages: number,
) {
  const seenActivities = new Set<string>();
  const seenMedia = new Set<string>();
  for (let number = 1; number <= maxPages; number++) {
    const data = parseJournalPage(await getPage(number));
    if (data.page !== number) {
      throw new DownloadError(
        "KinderCare returned an unexpected page. Download stopped to avoid missing photos.",
      );
    }
    if (Object.keys(data.intervals).length === 0) {
      return;
    }
    const activities = Object.values(data.intervals)
      .flatMap((interval) => Object.values(interval))
      .map((entry) => entry.activity);
    if (
      activities.length === 0 ||
      activities.every((activity) => seenActivities.has(activity.id))
    ) {
      throw new DownloadError(
        "The journal repeated a page or returned empty intervals. Download stopped to avoid looping indefinitely.",
      );
    }
    const media: Media[] = [];
    for (const activity of activities) {
      seenActivities.add(activity.id);
      for (const kind of ["image", "video"] satisfies Media["kind"][]) {
        const item: Media = { id: activity.id, kind };
        const journalDate = activity.list_date ?? activity.created_at;
        if (journalDate) {
          item.journalDate = journalDate;
        }
        if (activity[kind].url && !seenMedia.has(mediaKey(item))) {
          media.push(item);
          seenMedia.add(mediaKey(item));
        }
      }
    }
    // Text-only activities are valid. Keep paging until the explicit empty response.
    yield { number, media };
  }
  throw new DownloadError(
    "Reached the page limit before the end of the journal. Re-run with a higher --max-pages value.",
  );
}

export function journalApiUrl(value: string) {
  const url = new URL(value);
  if (url.origin === origin && !url.username && !url.password) {
    const account = /^\/accounts\/(\d+)\/(?:journal|activities)\/?$/.exec(
      url.pathname,
    );
    if (account) {
      return `${origin}/accounts/${account[1]}/journal_api`;
    }
    if (/^\/headlines\/?$/.test(url.pathname)) {
      return `${origin}/all_activities_api`;
    }
  }
  throw new DownloadError("No recognized saved journal. Run login again.");
}

export async function* journalPages(
  destination: string,
  get: GetResponse,
  delay: number,
  maxPages: number,
  signal?: AbortSignal,
) {
  const endpoint = journalApiUrl(destination);
  yield* collectJournalPages(async (number) => {
    if (number > 1) {
      await setTimeout(delay, undefined, { signal });
    }
    const response = await getWithRetry(
      `${endpoint}?page=${number}`,
      get,
      signal,
    );
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      throw new DownloadError(
        "Cannot read the photo journal. Run login again and check access on the website.",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new DownloadError(
        "KinderCare returned an invalid journal response. Try again later.",
      );
    }
  }, maxPages);
}
