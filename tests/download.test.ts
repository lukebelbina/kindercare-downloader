import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extensionFromBytes, saveMedia } from "../src/download.ts";
import { lockDirectory, readManifest } from "../src/files.ts";
import { allowedMediaUrl, mediaResponse } from "../src/http.ts";
import {
  journalUrl,
  type Manifest,
  manifestSchema,
  mediaUrl,
} from "../src/model.ts";

// Synthetic signatures only. No children's media or authenticated responses in fixtures.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);

function photoResponse() {
  return new Response(jpeg, {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(jpeg.length),
    },
  });
}

async function temporaryDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "kindercare-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("saves media and resumes without network requests for verified files", async () => {
  await temporaryDirectory(async (directory) => {
    const manifest = await readManifest(directory);
    const media = { id: "123", kind: "image" } satisfies Parameters<
      typeof saveMedia
    >[0];
    assert.equal(
      await saveMedia(media, directory, manifest, async () => photoResponse()),
      "saved",
    );
    const restored = await readManifest(directory);
    assert.equal(
      await saveMedia(media, directory, restored, async () => {
        throw new Error("must not fetch");
      }),
      "skipped",
    );
    assert.deepEqual(
      await readFile(join(directory, "activity-123-image.jpg")),
      jpeg,
    );
    assert.equal(JSON.stringify(restored).includes("https:"), false);
  });
});

test("recovers an interrupted manifest write without overwriting the saved file", async () => {
  await temporaryDirectory(async (directory) => {
    await writeFile(join(directory, "activity-123-image.jpg"), jpeg);
    const manifest: Manifest = { version: 1, files: {} };
    assert.equal(
      await saveMedia(
        { id: "123", kind: "image" },
        directory,
        manifest,
        async () => photoResponse(),
      ),
      "saved",
    );
    assert.equal(Object.keys((await readManifest(directory)).files).length, 1);
  });
});

test("detects changed files and refuses to overwrite them", async () => {
  await temporaryDirectory(async (directory) => {
    const manifest: Manifest = { version: 1, files: {} };
    const media = { id: "123", kind: "image" } satisfies Parameters<
      typeof saveMedia
    >[0];
    await saveMedia(media, directory, manifest, async () => photoResponse());
    await writeFile(join(directory, "activity-123-image.jpg"), "edited photo");
    await assert.rejects(
      saveMedia(media, directory, manifest, async () => photoResponse()),
      /not been overwritten/,
    );
    assert.equal(
      await readFile(join(directory, "activity-123-image.jpg"), "utf8"),
      "edited photo",
    );
    assert.equal(
      (await readdir(directory)).some((file) => file.endsWith(".part")),
      false,
    );
  });
});

test("rejects login HTML, including HTML incorrectly labeled as an image", async () => {
  await temporaryDirectory(async (directory) => {
    const manifest: Manifest = { version: 1, files: {} };
    for (const type of ["text/html", "image/jpeg"]) {
      await assert.rejects(
        saveMedia(
          { id: "123", kind: "image" },
          directory,
          manifest,
          async () =>
            new Response("<html>Sign in</html>", {
              headers: { "content-type": type },
            }),
        ),
      );
    }
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(manifest.files, {});
  });
});

test("truncated and interrupted transfers never become completed downloads", async () => {
  await temporaryDirectory(async (directory) => {
    const manifest: Manifest = { version: 1, files: {} };
    await assert.rejects(
      saveMedia(
        { id: "123", kind: "image" },
        directory,
        manifest,
        async () =>
          new Response(jpeg, {
            headers: { "content-type": "image/jpeg", "content-length": "1000" },
          }),
      ),
      /incomplete/,
    );
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new Error("disconnected"));
      },
    });
    await assert.rejects(
      saveMedia(
        { id: "123", kind: "image" },
        directory,
        manifest,
        async () =>
          new Response(stream, { headers: { "content-type": "image/jpeg" } }),
      ),
    );
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(manifest.files, {});
  });
});

test("refuses corrupted manifests and traversal filenames", async () => {
  await temporaryDirectory(async (directory) => {
    await writeFile(join(directory, "manifest.json"), "broken JSON");
    await assert.rejects(readManifest(directory), /manifest/);
    assert.equal(
      manifestSchema.safeParse({
        version: 1,
        files: {
          "123:image": {
            filename: "../secret",
            size: 1,
            sha256: "a".repeat(64),
          },
        },
      }).success,
      false,
    );
    assert.throws(() => mediaUrl({ id: "../../secret", kind: "image" }));
  });
});

test("directory locks exclude overlapping syncs and release cleanly", async () => {
  await temporaryDirectory(async (directory) => {
    const release = await lockDirectory(directory);
    await assert.rejects(lockDirectory(directory), /locked/);
    await release();
    await (await lockDirectory(directory))();
  });
});

test("redirects allow HTTPS media hosts and reject credential leaks and local addresses", async () => {
  const seen: string[] = [];
  const response = await mediaResponse(
    "https://classroom.kindercare.com/activities/123.image",
    async (url) => {
      seen.push(url);
      return seen.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://example.cloudfront.net/photo" },
          })
        : photoResponse();
    },
  );
  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  for (const url of [
    "http://example.cloudfront.net/photo",
    "https://localhost/a",
    "https://127.0.0.1/a",
    "https://kindercare.com.evil.example/a",
    "https://user:pass@classroom.kindercare.com/a",
  ]) {
    assert.throws(() => allowedMediaUrl(url));
  }
});

test("file type is determined from bytes and unknown responses fail closed", () => {
  assert.equal(extensionFromBytes(jpeg), "jpg");
  assert.equal(extensionFromBytes(Buffer.from([80, 75, 3, 4])), "zip");
  assert.equal(extensionFromBytes(Buffer.from("\0\0\0\x18ftypmp42")), "mp4");
  assert.throws(() =>
    extensionFromBytes(Buffer.from('{"error":"unauthorized"}')),
  );
});

test("saved journal locations strip query secrets and reject other sites", () => {
  assert.equal(
    journalUrl(
      "https://classroom.kindercare.com/accounts/123/activities?token=secret#private",
    ),
    "https://classroom.kindercare.com/accounts/123/activities",
  );
  assert.throws(() => journalUrl("https://example.com/"));
});

test("filesystems without hard links use exclusive copy and preserve existing files", async () => {
  const { publishFile } = await import("../src/files.ts");
  await temporaryDirectory(async (directory) => {
    const source = join(directory, "source.part");
    const destination = join(directory, "photo.jpg");
    await writeFile(source, jpeg);
    const unsupported = async () => {
      throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
    };
    await publishFile(source, destination, unsupported);
    assert.deepEqual(await readFile(destination), jpeg);
    await writeFile(source, "different bytes");
    await assert.rejects(publishFile(source, destination, unsupported), {
      code: "EEXIST",
    });
    assert.deepEqual(await readFile(destination), jpeg);
    await assert.rejects(
      publishFile(source, destination, async () => {
        throw Object.assign(new Error("I/O failure"), { code: "EIO" });
      }),
      { code: "EIO" },
    );
  });
});

test("lock creation errors are not reported as existing locks", async () => {
  await temporaryDirectory(async (directory) => {
    await assert.rejects(
      lockDirectory(join(directory, "missing")),
      /Cannot create the directory lock/,
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test("manifest schema errors preserve recovery guidance", async () => {
  await temporaryDirectory(async (directory) => {
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ version: 999 }),
    );
    await assert.rejects(readManifest(directory), /Restore it from a backup/);
  });
});

test("backfills journal dates without downloading or changing bytes and restores times on rerun", async () => {
  const { stat, utimes } = await import("node:fs/promises");
  await temporaryDirectory(async (directory) => {
    const manifest = await readManifest(directory);
    const media = { id: "123", kind: "image" as const };
    await saveMedia(media, directory, manifest, async () => photoResponse());
    const originalHash = manifest.files["123:image"]?.sha256;
    const dated = { ...media, journalDate: "2024-02-29T12:30:00.000-08:00" };
    const noFetch = async (): Promise<Response> => {
      throw new Error("must not download");
    };
    assert.equal(
      await saveMedia(dated, directory, manifest, noFetch),
      "skipped",
    );
    const path = join(directory, "activity-123-image.jpg");
    assert.equal((await stat(path)).mtimeMs, Date.parse(dated.journalDate));
    const restored = await readManifest(directory);
    assert.equal(restored.files["123:image"]?.journalDate, dated.journalDate);
    assert.equal(restored.files["123:image"]?.sha256, originalHash);
    assert.deepEqual(await readFile(path), jpeg);
    await utimes(path, new Date(), new Date());
    await saveMedia(media, directory, restored, noFetch);
    assert.equal((await stat(path)).mtimeMs, Date.parse(dated.journalDate));
  });
});

test("new downloads get the journal time without altering embedded bytes", async () => {
  const { stat } = await import("node:fs/promises");
  await temporaryDirectory(async (directory) => {
    const manifest = await readManifest(directory);
    const media = {
      id: "123",
      kind: "image" as const,
      journalDate: "2023-11-05T01:30:00-07:00",
    };
    await saveMedia(media, directory, manifest, async () => photoResponse());
    const path = join(directory, "activity-123-image.jpg");
    assert.equal((await stat(path)).mtimeMs, Date.parse(media.journalDate));
    assert.deepEqual(await readFile(path), jpeg);
    await writeFile(path, "modified");
    const before = (await stat(path)).mtimeMs;
    await assert.rejects(
      saveMedia(media, directory, manifest, async () => photoResponse()),
      /not been overwritten/,
    );
    assert.equal((await stat(path)).mtimeMs, before);
  });
});
