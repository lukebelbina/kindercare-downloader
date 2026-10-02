import assert from "node:assert/strict";
import { test } from "node:test";
import { collectJournalPages } from "../src/journal.ts";

function activity(id: number, kind: "image" | "video" | "text" = "image") {
  return {
    activity: {
      id,
      image: { url: kind === "image" ? "https://example.invalid/photo" : null },
      video: { url: kind === "video" ? "https://example.invalid/video" : null },
    },
  };
}

async function collect(pages: unknown[], limit = 100) {
  const result = [];
  for await (const batch of collectJournalPages(
    async (number) => pages[number - 1],
    limit,
  )) {
    result.push(batch);
  }
  return result;
}

test("paginates through text-only pages, deduplicates overlaps, and ends only on empty intervals", async () => {
  const result = await collect([
    { page: 1, intervals: { day: [activity(1)] } },
    { page: 2, intervals: { day: [activity(2, "text")] } },
    {
      page: 3,
      intervals: { day: { a: activity(1), b: activity(3, "video") } },
    },
    { page: 4, intervals: {} },
  ]);
  assert.deepEqual(
    result.map((batch) => batch.media),
    [[{ id: "1", kind: "image" }], [], [{ id: "3", kind: "video" }]],
  );
});

test("repeated pages and mismatched page numbers cannot report completion", async () => {
  await assert.rejects(
    collect([
      { page: 1, intervals: { day: [activity(1)] } },
      { page: 2, intervals: { day: [activity(1)] } },
    ]),
    /repeated/,
  );
  await assert.rejects(
    collect([{ page: 2, intervals: {} }]),
    /unexpected page/,
  );
});

test("unknown API schemas fail without exposing raw data", async () => {
  await assert.rejects(
    collect([
      { page: 1, intervals: { day: [{ privateToken: "do-not-log" }] } },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /format is not recognized/);
      assert.equal(error.message.includes("do-not-log"), false);
      return true;
    },
  );
});

test("hitting the safety limit reports an incomplete archive", async () => {
  await assert.rejects(
    collect([{ page: 1, intervals: { day: [activity(1)] } }], 1),
    /page limit/,
  );
});

test("preserves journal timestamps with offsets and rejects ambiguous or invalid dates", async () => {
  const entry = {
    activity: {
      ...activity(1).activity,
      list_date: "2024-02-29T12:30:00.000-08:00",
    },
  };
  const batches = await collect([
    { page: 1, intervals: { day: [entry] } },
    { page: 2, intervals: {} },
  ]);
  assert.equal(batches[0]?.media[0]?.journalDate, entry.activity.list_date);
  for (const value of [
    "2024-02-30T12:30:00Z",
    "2024-01-01T12:30:00",
    "private-invalid-date",
  ]) {
    await assert.rejects(
      collect([
        {
          page: 1,
          intervals: {
            day: [{ activity: { ...entry.activity, list_date: value } }],
          },
        },
      ]),
      /format is not recognized/,
    );
  }
});

test("older entries use their creation timestamp, with explicit journal dates taking priority", async () => {
  const created = "2020-01-01T10:00:00-08:00";
  const listed = "2020-01-02T11:00:00-08:00";
  const result = await collect([
    {
      page: 1,
      intervals: {
        day: [
          {
            activity: {
              ...activity(1).activity,
              list_date: null,
              created_at: created,
            },
          },
          {
            activity: {
              ...activity(2).activity,
              list_date: listed,
              created_at: created,
            },
          },
          {
            activity: {
              ...activity(3).activity,
              list_date: null,
              created_at: null,
            },
          },
        ],
      },
    },
    { page: 2, intervals: {} },
  ]);
  assert.deepEqual(
    result[0]?.media.map((media) => media.journalDate),
    [created, listed, undefined],
  );
});
