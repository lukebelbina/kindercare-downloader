import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { atomicJson, isMissing, publishFile, verifiedFile } from "./files.ts";
import { type GetResponse, mediaResponse } from "./http.ts";
import {
  DownloadError,
  type Manifest,
  type Media,
  mediaKey,
  mediaUrl,
} from "./model.ts";

export function extensionFromBytes(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "jpg";
  }
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "png";
  }
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) {
    return "gif";
  }
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  ) {
    return "webp";
  }
  if (bytes.subarray(4, 8).toString() === "ftyp") {
    const brand = bytes.subarray(8, 12).toString();
    if (/^(heic|heix|hevc|hevx|mif1)$/.test(brand)) {
      return "heic";
    }
    if (brand === "qt  ") {
      return "mov";
    }
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand)) {
      return "mp4";
    }
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
    return "zip";
  }
  throw new DownloadError(
    "The response was not a supported photo, video, or ZIP archive. It may be a login page; run login again.",
  );
}

// Files retain their exact bytes and embedded capture metadata. The journal date
// is only a filesystem fallback for importers when embedded dates are absent.
async function setJournalTime(path: string, journalDate: string | undefined) {
  if (journalDate) {
    const stat = await lstat(path);
    await utimes(path, stat.atime, new Date(journalDate));
  }
}

export async function saveMedia(
  media: Media,
  directory: string,
  manifest: Manifest,
  get: GetResponse,
  signal?: AbortSignal,
) {
  const key = mediaKey(media);
  const existing = manifest.files[key];
  if (existing && (await verifiedFile(directory, existing))) {
    const journalDate = media.journalDate ?? existing.journalDate;
    await setJournalTime(join(directory, existing.filename), journalDate);
    if (journalDate && existing.journalDate !== journalDate) {
      existing.journalDate = journalDate;
      await atomicJson(join(directory, "manifest.json"), manifest);
    }
    return "skipped";
  }
  const response = await mediaResponse(mediaUrl(media), get, undefined, signal);
  const contentType =
    response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (
    !/^(image\/|video\/|application\/(octet-stream|zip|x-zip-compressed)$)/.test(
      contentType,
    ) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new DownloadError(
      "KinderCare did not return a media file. Run login again or check that the photo still opens on the website.",
    );
  }
  const temporary = join(directory, `${randomUUID()}.part`);
  const hash = createHash("sha256");
  let size = 0;
  let prefix = Buffer.alloc(0);
  try {
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > 2 * 1024 ** 3) {
          callback(
            new DownloadError("A file exceeded the 2 GiB download limit."),
          );
          return;
        }
        hash.update(chunk);
        if (prefix.length < 32) {
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, 32 - prefix.length),
          ]);
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(response.body),
      meter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const expectedLength = response.headers.get("content-length");
    if (
      expectedLength &&
      !response.headers.get("content-encoding") &&
      Number(expectedLength) !== size
    ) {
      throw new DownloadError(
        "The download was incomplete. Re-run sync to retry it.",
      );
    }
    const extension = extensionFromBytes(prefix);
    const filename = `activity-${media.id}-${media.kind}.${extension}`;
    const destination = join(directory, filename);
    const sha256 = hash.digest("hex");
    try {
      const stat = await lstat(destination);
      if (
        !stat.isFile() ||
        !(await verifiedFile(directory, { filename, size, sha256 }))
      ) {
        throw new DownloadError(
          "A destination file differs from the download. Move that file aside before retrying; it has not been overwritten.",
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      // Never replace a destination created after the existence check.
      await publishFile(temporary, destination);
    }
    const journalDate = media.journalDate ?? existing?.journalDate;
    await setJournalTime(destination, journalDate);
    manifest.files[key] = {
      filename,
      size,
      sha256,
      ...(journalDate ? { journalDate } : {}),
    };
    await atomicJson(join(directory, "manifest.json"), manifest);
    return "saved";
  } finally {
    await rm(temporary, { force: true });
  }
}
