import assert from "node:assert/strict";
import { test } from "node:test";
import { createGetResponse } from "../src/http.ts";
import { journalApiUrl, journalPages } from "../src/journal.ts";
import { origin } from "../src/model.ts";
import { SessionCookies } from "../src/session.ts";

test("respects cookie expiry and paths and persists rotated sessions", async () => {
  const session = new SessionCookies();
  const headers = new Headers();
  for (const cookie of [
    "session=synthetic; Path=/; Secure; HttpOnly",
    "expired=old; Path=/; Max-Age=0",
    "private=other-path; Path=/private; Secure",
    "unrelated=other-domain; Domain=example.com; Path=/",
  ]) {
    headers.append("set-cookie", cookie);
  }
  await session.receiveCookies(origin, headers);
  assert.deepEqual(await session.cookies(`${origin}/accounts/1/journal_api`), [
    { name: "session", value: "synthetic" },
  ]);
  await session.receiveCookies(
    origin,
    new Headers({ "set-cookie": "session=rotated; Path=/; Secure; HttpOnly" }),
  );
  const restored = await SessionCookies.load(
    JSON.parse(JSON.stringify(session.toJSON())),
  );
  assert.deepEqual(await restored.cookies(origin), [
    { name: "session", value: "rotated" },
  ]);
  await restored.receiveCookies(
    origin,
    new Headers({ "set-cookie": "session=deleted; Path=/; Max-Age=0" }),
  );
  assert.deepEqual(await restored.cookies(origin), []);
});

test("native fetch receives session updates only from KinderCare", async (t) => {
  const session = new SessionCookies();
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(null, {
        headers: { "set-cookie": "session=synthetic; Path=/; Secure" },
      }),
  );
  const get = createGetResponse(session);
  await get("https://example.cloudfront.net/photo");
  assert.deepEqual(await session.cookies(origin), []);
  await get(`${origin}/accounts/1/journal_api`);
  assert.deepEqual(await session.cookies(origin), [
    { name: "session", value: "synthetic" },
  ]);
});

test("resolves only known journal routes without needing a DOM", () => {
  assert.equal(
    journalApiUrl(`${origin}/accounts/123/activities?token=synthetic`),
    `${origin}/accounts/123/journal_api`,
  );
  assert.equal(
    journalApiUrl(`${origin}/accounts/123/journal`),
    `${origin}/accounts/123/journal_api`,
  );
  assert.equal(
    journalApiUrl(`${origin}/headlines`),
    `${origin}/all_activities_api`,
  );
  assert.throws(() =>
    journalApiUrl("https://example.com/accounts/123/journal"),
  );
  assert.throws(() => journalApiUrl(`${origin}/staff`));
});

test("browser-free pagination stops at explicit end and rejects expired sessions", async () => {
  const urls: string[] = [];
  for await (const batch of journalPages(
    `${origin}/accounts/123/journal`,
    async (url) => {
      urls.push(url);
      return Response.json({ page: 1, intervals: {} });
    },
    0,
    10,
  )) {
    assert.fail(`Unexpected batch ${batch.number}`);
  }
  assert.deepEqual(urls, [`${origin}/accounts/123/journal_api?page=1`]);
  for (const response of [
    new Response(null, { status: 302, headers: { location: "/login" } }),
    new Response("<html>Login</html>", {
      headers: { "content-type": "text/html" },
    }),
  ]) {
    await assert.rejects(async () => {
      for await (const _batch of journalPages(
        `${origin}/headlines`,
        async () => response,
        0,
        10,
      )) {
        assert.fail("Must not produce entries");
      }
    }, /Run login again/);
  }
});

test("rejects legacy and invalid session formats", async () => {
  await assert.rejects(SessionCookies.load({ cookies: [] }));
  await assert.rejects(SessionCookies.load({ version: 2, cookieJar: {} }));
});

test("journal requests share the long rate-limit stop policy", async () => {
  let attempts = 0;
  await assert.rejects(async () => {
    for await (const _batch of journalPages(
      `${origin}/headlines`,
      async () => {
        attempts++;
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "300" },
        });
      },
      0,
      10,
    )) {
      assert.fail("Must not yield a rate-limited page");
    }
  }, /at least 300 seconds/);
  assert.equal(attempts, 1);
});
