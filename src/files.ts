import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { DownloadError, type Manifest, manifestSchema } from "./model.ts";

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) {
    throw new DownloadError(
      "The data directory must be a regular directory, not a symbolic link.",
    );
  }
  await chmod(path, 0o700);
}

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readManifest(directory: string): Promise<Manifest> {
  try {
    const parsed = manifestSchema.safeParse(
      JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
    );
    if (!parsed.success) {
      throw new DownloadError(
        "The download manifest is invalid. Restore it from a backup before continuing.",
      );
    }
    return parsed.data;
  } catch (error) {
    if (isMissing(error)) {
      return { version: 1, files: {} };
    }
    if (error instanceof DownloadError) {
      throw error;
    }
    throw new DownloadError(
      "Cannot read the download manifest. Check its permissions and JSON format.",
    );
  }
}

export function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function verifiedFile(
  directory: string,
  entry: Manifest["files"][string],
) {
  const path = join(directory, entry.filename);
  try {
    const stat = await lstat(path);
    return (
      stat.isFile() &&
      stat.size === entry.size &&
      (await hashFile(path)) === entry.sha256
    );
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

export async function lockDirectory(directory: string) {
  const path = join(directory, ".download.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new DownloadError(
        "The directory is locked. Stop other downloader runs; after a crash, remove .download.lock from that directory.",
      );
    }
    throw new DownloadError(
      "Cannot create the directory lock. Check directory permissions and available disk space.",
    );
  }
  await lock.close();
  return async () => {
    await rm(path, { force: true });
  };
}

// Hard links publish atomically on supporting filesystems. Exclusive copy also
// prevents replacement on exFAT/FAT32; only record completion after it succeeds.
export async function publishFile(
  source: string,
  destination: string,
  createLink: typeof link = link,
) {
  try {
    await createLink(source, destination);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(String(error.code))
    ) {
      throw error;
    }
    await copyFile(source, destination, constants.COPYFILE_EXCL);
  }
}
