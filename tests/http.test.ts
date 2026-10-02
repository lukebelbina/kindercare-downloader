import assert from "node:assert/strict";
import { test } from "node:test";
import { createGetResponse, getWithRetry, mediaResponse } from "../src/http.ts";

test("session cookies go only to the exact KinderCare origin, never the CDN", async (t) => {
  const requests: { url: string; cookie: string | null }[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    requests.push({
      url: input.href,
      cookie: new Headers(init.headers).get("cookie"),
    });
    return new Response(null);
  });
  const get = createGetResponse({
    cookies: async () => [
      {
        name: "session",
        value: "synthetic-test-value",
        domain: "classroom.kindercare.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
  });
  await get("https://classroom.kindercare.com/activities/1.image");
  await get("https://example.cloudfront.net/photo");
  assert.equal(requests[0]?.cookie, "session=synthetic-test-value");
  assert.equal(requests[1]?.cookie, null);
});

test("rate limits are retried with bounded backoff", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const response = await mediaResponse(
    "https://classroom.kindercare.com/activities/1.image",
    async () => {
      attempts++;
      return attempts === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "3" } })
        : new Response(null);
    },
    async (delay) => {
      delays.push(delay);
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(delays, [3000]);
});

test("persistent server failures stop after four attempts", async () => {
  let attempts = 0;
  await assert.rejects(
    mediaResponse(
      "https://classroom.kindercare.com/activities/1.image",
      async () => {
        attempts++;
        return new Response(null, { status: 503 });
      },
      async () => {},
    ),
    /busy or rate limiting/,
  );
  assert.equal(attempts, 4);
});

test("cancellation interrupts a media retry wait without another request", async () => {
  const cancellation = new AbortController();
  let attempts = 0;
  const result = mediaResponse(
    "https://classroom.kindercare.com/activities/1.image",
    async () => {
      attempts++;
      setImmediate(() => cancellation.abort());
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "60" },
      });
    },
    undefined,
    cancellation.signal,
  );
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("long Retry-After values stop without retrying early and cancel the body", async () => {
  for (const retryAfter of [
    "300",
    new Date(Date.now() + 300_000).toUTCString(),
  ]) {
    let attempts = 0;
    let cancelled = false;
    await assert.rejects(
      getWithRetry(
        "https://classroom.kindercare.com/headlines",
        async () => {
          attempts++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: 429,
              headers: { "retry-after": retryAfter },
            },
          );
        },
        undefined,
        async () => {
          assert.fail("Must not wait or retry before the server permits it");
        },
      ),
      /Try sync again in at least \d+ seconds/,
    );
    assert.equal(attempts, 1);
    assert.equal(cancelled, true);
  }
});
