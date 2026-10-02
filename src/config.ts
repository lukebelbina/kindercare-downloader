import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DownloadError } from "./model.ts";

export const settingsSchema = z.strictObject({
  output: z
    .string()
    .min(1)
    .default(join(homedir(), "Pictures", "Kindercare")),
  stateDir: z
    .string()
    .min(1)
    .default(join(homedir(), ".kindercare-downloader")),
  delayMs: z.number().int().min(250).max(60_000).default(500),
  maxPages: z.number().int().min(1).max(100_000).default(10_000),
});
const configFileSchema = settingsSchema.partial();

export function folderPath(value: string, base = process.cwd()) {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(base, value);
}

export async function loadSettings(filename?: string) {
  if (filename === undefined) {
    return {};
  }
  if (!filename.trim()) {
    throw new DownloadError("--config requires a file path.");
  }
  const path = folderPath(filename);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new DownloadError(
      "Cannot read the config file. Check --config points to a readable JSON file.",
    );
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DownloadError(
      "Invalid config file. Allowed settings: output, stateDir (nonempty paths), delayMs (250–60000), maxPages (1–100000). See README for an example.",
    );
  }
  const settings = parsed.data;
  return {
    ...settings,
    ...(settings.output === undefined
      ? {}
      : { output: folderPath(settings.output, dirname(path)) }),
    ...(settings.stateDir === undefined
      ? {}
      : { stateDir: folderPath(settings.stateDir, dirname(path)) }),
  };
}
