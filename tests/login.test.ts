import assert from "node:assert/strict";
import { test } from "node:test";
import { origin } from "../src/model.ts";
import { authenticate, loginToken } from "../src/terminal-login.ts";

const token = "synthetic-csrf-token-123456";
const form = `<form><input value='${token}' type="hidden" name='authenticity_token'></form>`;
const signal = () => new AbortController().signal;

test("recognizes the observed CSRF input without accepting missing or ambiguous tokens", () => {
  assert.equal(loginToken(form), token);
  assert.equal(
    loginToken(
      `<input type=hidden name=authenticity_token value=${token} autocomplete=off />`,
    ),
    token,
  );
  assert.throws(() => loginToken("<html>challenge</html>"), /not recognized/);
  assert.throws(() => loginToken(form + form), /not recognized/);
  assert.throws(
    () => loginToken(form.replace(token, "secret<script>")),
    /not recognized/,
  );
});

test("terminal authentication posts CSRF and cookies, encodes credentials, and verifies journal access", async () => {
  let count = 0;
  const session = await authenticate(
    "test+parent@example.invalid",
    "synthetic & password=1",
    `${origin}/headlines`,
    signal(),
    async (url, init) => {
      count++;
      assert.equal(init?.redirect, "manual");
      assert.equal(new URL(String(url)).origin, origin);
      if (count === 1) {
        assert.equal(url, `${origin}/login`);
        assert.equal(init?.method, "GET");
        return new Response(form, {
          headers: {
            "content-type": "text/html",
            "set-cookie": "session=prelogin; Path=/; Secure",
          },
        });
      }
      if (count === 2) {
        assert.equal(url, `${origin}/login`);
        assert.equal(init?.method, "POST");
        assert.equal(
          new Headers(init.headers).get("cookie"),
          "session=prelogin",
        );
        const body = new URLSearchParams(String(init.body));
        assert.equal(body.get("authenticity_token"), token);
        assert.equal(body.get("user[login]"), "test+parent@example.invalid");
        assert.equal(body.get("user[password]"), "synthetic & password=1");
        return new Response(null, {
          status: 302,
          headers: {
            location: "/headlines",
            "set-cookie": "session=authenticated; Path=/; Secure",
          },
        });
      }
      assert.equal(count, 3);
      assert.equal(url, `${origin}/all_activities_api?page=1`);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(
        new Headers(init?.headers).get("cookie"),
        "session=authenticated",
      );
      return Response.json({ page: 1, intervals: {} });
    },
  );
  assert.equal(count, 3);
  assert.deepEqual(await session.cookies(origin), [
    { name: "session", value: "authenticated" },
  ]);
  assert.ok(!JSON.stringify(session.toJSON()).includes("synthetic & password"));
});

test("an authentication redirect is not trusted, and credentials never follow it", async () => {
  let count = 0;
  await assert.rejects(
    authenticate(
      "synthetic",
      "synthetic",
      `${origin}/headlines`,
      signal(),
      async (url, init) => {
        count++;
        assert.equal(new URL(String(url)).origin, origin);
        if (count === 1) {
          return new Response(form, {
            headers: { "content-type": "text/html" },
          });
        }
        if (count === 2) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.invalid/verification" },
          });
        }
        assert.equal(init?.body, undefined);
        return new Response("private error contents", {
          headers: { "content-type": "text/html" },
        });
      },
    ),
    (error) =>
      error instanceof Error &&
      /Sign-in was not completed/.test(error.message) &&
      !error.message.includes("private"),
  );
  assert.equal(count, 3);
});

test("rate-limited password submissions are never retried", async () => {
  let count = 0;
  await assert.rejects(
    authenticate(
      "synthetic",
      "synthetic",
      `${origin}/headlines`,
      signal(),
      async () => {
        count++;
        return count === 1
          ? new Response(form, { headers: { "content-type": "text/html" } })
          : new Response(null, { status: 429 });
      },
    ),
    /rate limiting/,
  );
  assert.equal(count, 2);
});
