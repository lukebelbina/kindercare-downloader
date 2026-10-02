import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { origin } from "../src/model.ts";
import { SessionCookies } from "../src/session.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("status is read-only with absent state and never prints saved cookie values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kindercare-cli-"));
  try {
    const missing = join(directory, "missing state");
    const output = join(directory, "photo archive");
    const absent = await execute(process.execPath, [
      cli,
      "status",
      "--state-dir",
      missing,
      "--output",
      output,
    ]);
    assert.match(absent.stdout, /Journal configured: no/);
    assert.deepEqual(await readdir(directory), []);
    await writeFile(
      join(directory, "session.json"),
      JSON.stringify({
        journalUrl: "https://classroom.kindercare.com/headlines",
      }),
    );
    const session = new SessionCookies();
    await session.receiveCookies(
      origin,
      new Headers({
        "set-cookie":
          "session=synthetic-secret-must-not-appear; Path=/; Secure; HttpOnly",
      }),
    );
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify(session.toJSON()),
    );
    const present = await execute(process.execPath, [
      cli,
      "status",
      "--state-dir",
      directory,
      "--output",
      output,
    ]);
    assert.match(present.stdout, /Journal configured: yes/);
    assert.match(present.stdout, /Unexpired local cookies: present/);
    assert.equal(
      (present.stdout + present.stderr).includes(
        "synthetic-secret-must-not-appear",
      ),
      false,
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      "auth.json",
      "session.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config paths use the config directory and CLI settings override the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kindercare-config-"));
  try {
    const config = join(directory, "settings.json");
    await writeFile(
      config,
      JSON.stringify({
        output: "photo archive",
        stateDir: "login state",
        delayMs: 900,
        maxPages: 25,
      }),
    );
    const configured = await execute(process.execPath, [
      cli,
      "status",
      "--config",
      config,
    ]);
    assert.ok(
      configured.stdout.includes(
        `Media directory: ${join(directory, "photo archive")}`,
      ),
    );
    assert.ok(
      configured.stdout.includes(
        `Session directory: ${join(directory, "login state")}`,
      ),
    );
    assert.match(configured.stdout, /Delay: 900 ms/);
    assert.match(configured.stdout, /Page limit: 25/);
    const overridden = await execute(
      process.execPath,
      [
        cli,
        "status",
        "--config",
        config,
        "--output",
        "override photos",
        "--state-dir",
        "override state",
        "--delay-ms",
        "1200",
        "--max-pages",
        "30",
      ],
      { cwd: directory },
    );
    assert.ok(
      overridden.stdout.includes(
        `Media directory: ${join(directory, "override photos")}`,
      ),
    );
    assert.ok(
      overridden.stdout.includes(
        `Session directory: ${join(directory, "override state")}`,
      ),
    );
    assert.match(overridden.stdout, /Delay: 1200 ms/);
    assert.match(overridden.stdout, /Page limit: 30/);
    assert.deepEqual(await readdir(directory), ["settings.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bad or missing configs fail before creating state and do not expose contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kindercare-config-"));
  try {
    const config = join(directory, "settings.json");
    const args = [
      cli,
      "status",
      "--config",
      config,
      "--state-dir",
      join(directory, "state"),
    ];
    await assert.rejects(
      execute(process.execPath, args),
      /Cannot read the config file/,
    );
    for (const content of [
      "not JSON",
      JSON.stringify({ password: "synthetic-secret" }),
      JSON.stringify({ delayMs: 0 }),
      JSON.stringify({ output: "" }),
      JSON.stringify({ maxPages: "20" }),
    ]) {
      await writeFile(config, content);
      await assert.rejects(
        execute(process.execPath, args),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok("stderr" in error);
          assert.match(String(error.stderr), /config file/);
          assert.equal(
            String(error.stderr).includes("synthetic-secret"),
            false,
          );
          return true;
        },
      );
    }
    assert.deepEqual(await readdir(directory), ["settings.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
