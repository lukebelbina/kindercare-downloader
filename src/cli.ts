import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { folderPath, loadSettings, settingsSchema } from "./config.ts";
import { saveMedia } from "./download.ts";
import {
  atomicJson,
  lockDirectory,
  privateDirectory,
  readManifest,
} from "./files.ts";
import { createGetResponse } from "./http.ts";
import { journalPages } from "./journal.ts";
import { DownloadError, journalUrl, origin } from "./model.ts";

import { SessionCookies } from "./session.ts";

const configSchema = z.object({ journalUrl: z.string().transform(journalUrl) });

const optionsSchema = settingsSchema.extend({
  journal: z.string().transform(journalUrl),
  command: z.enum(["login", "sync", "logout", "status"]),
});

function help() {
  console.info(`KinderCare downloader

  node src/cli.ts login       Sign in from the terminal (password hidden)
  node src/cli.ts sync        Download the selected journal, skipping verified files
  node src/cli.ts logout      Remove the locally saved login
  node src/cli.ts status      Show local configuration without contacting KinderCare

Options:
  --config PATH              Optional JSON settings file (no automatic discovery)
  --journal URL              Entries/journal URL (login only; default: all children)
  --output PATH              Media directory (default: ~/Pictures/Kindercare)
  --state-dir PATH           Session directory (default: ~/.kindercare-downloader)
  --delay-ms NUMBER          Delay between downloads (default: 500, minimum: 250)
  --max-pages NUMBER         Page safety limit (default: 10000)
  --help                     Show this help

Terminal login selects all accessible children by default. Use --journal URL to select
a child. CLI options override config settings, which override defaults.
Config folder paths are relative to the config file; CLI paths use the current directory.
`);
}

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      journal: { type: "string" },
      output: { type: "string" },
      "state-dir": { type: "string" },
      "delay-ms": { type: "string" },
      "max-pages": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    help();
    return;
  }
  const settings = await loadSettings(values.config);
  const parsed = optionsSchema.safeParse({
    journal: values.journal ?? `${origin}/headlines`,
    command: positionals[0],
    output: values.output ?? settings.output,
    stateDir: values["state-dir"] ?? settings.stateDir,
    delayMs:
      values["delay-ms"] === undefined
        ? settings.delayMs
        : Number(values["delay-ms"]),
    maxPages:
      values["max-pages"] === undefined
        ? settings.maxPages
        : Number(values["max-pages"]),
  });
  if (!parsed.success || positionals.length !== 1) {
    throw new DownloadError(
      "Invalid arguments. Run node src/cli.ts --help for usage.",
    );
  }
  const options = parsed.data;
  if (options.command !== "login" && values.journal) {
    throw new DownloadError("Use --journal only with login.");
  }
  const stateDirectory = folderPath(options.stateDir);
  const outputDirectory = folderPath(options.output);
  if (stateDirectory === outputDirectory) {
    throw new DownloadError(
      "Use different directories for session state and downloaded media.",
    );
  }
  console.info(`Session directory: ${stateDirectory}`);
  console.info(`Media directory: ${outputDirectory}`);
  if (options.command === "status") {
    console.info(`Delay: ${options.delayMs} ms`);
    console.info(`Page limit: ${options.maxPages}`);
    let configured = false;
    try {
      configSchema.parse(
        JSON.parse(
          await readFile(join(stateDirectory, "session.json"), "utf8"),
        ),
      );
      configured = true;
    } catch {}
    let savedLogin = false;
    try {
      const session = await SessionCookies.load(
        JSON.parse(await readFile(join(stateDirectory, "auth.json"), "utf8")),
      );
      savedLogin = (await session.cookies(origin)).length > 0;
    } catch {}
    console.info(`Journal configured: ${configured ? "yes" : "no"}`);
    console.info(`Unexpired local cookies: ${savedLogin ? "present" : "none"}`);
    console.info(
      "Status is local only; server access and session validity have not been checked.",
    );
    if (!configured || !savedLogin) {
      console.info("Run node src/cli.ts login before sync.");
    }
    return;
  }
  await privateDirectory(stateDirectory);
  const unlockState = await lockDirectory(stateDirectory);
  const authPath = join(stateDirectory, "auth.json");
  const configPath = join(stateDirectory, "session.json");
  try {
    if (options.command === "logout") {
      await rm(authPath, { force: true });
      await rm(configPath, { force: true });
      console.info("Saved login removed. Downloaded media is unchanged.");
      return;
    }
    let destination = origin;
    if (options.command === "sync") {
      try {
        destination = configSchema.parse(
          JSON.parse(await readFile(configPath, "utf8")),
        ).journalUrl;
      } catch {
        throw new DownloadError(
          "No valid saved journal. Run node src/cli.ts login first.",
        );
      }
    }
    console.info(
      options.command === "login"
        ? "Signing in to KinderCare."
        : "Downloading your selected KinderCare journal.",
    );
    const cancellation = new AbortController();
    const interrupt = () => cancellation.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      if (options.command === "login") {
        const { terminalLogin } = await import("./terminal-login.ts");
        await terminalLogin(
          authPath,
          configPath,
          options.journal,
          cancellation.signal,
        );
        return;
      }
      let session: SessionCookies;
      try {
        session = await SessionCookies.load(
          JSON.parse(await readFile(authPath, "utf8")),
        );
      } catch {
        throw new DownloadError(
          "No valid saved login. Run node src/cli.ts login first.",
        );
      }
      await privateDirectory(outputDirectory);
      const unlockOutput = await lockDirectory(outputDirectory);
      let saved = 0;
      let skipped = 0;
      try {
        const manifest = await readManifest(outputDirectory);
        const get = createGetResponse(session, cancellation.signal);
        for await (const batch of journalPages(
          destination,
          get,
          options.delayMs,
          options.maxPages,
          cancellation.signal,
        )) {
          for (const media of batch.media) {
            cancellation.signal.throwIfAborted();
            const result = await saveMedia(
              media,
              outputDirectory,
              manifest,
              get,
              cancellation.signal,
            );
            if (result === "saved") {
              saved++;
              await setTimeout(options.delayMs, undefined, {
                signal: cancellation.signal,
              });
            } else {
              skipped++;
            }
          }
          console.info(
            `Page ${batch.number}: ${saved} saved, ${skipped} already downloaded.`,
          );
        }
        await atomicJson(authPath, session.toJSON());
        console.info(
          `Finished the selected journal: ${saved} saved, ${skipped} already downloaded.`,
        );
      } finally {
        await unlockOutput();
      }
    } catch (error) {
      if (cancellation.signal.aborted) {
        throw new DownloadError(
          "Download interrupted. Completed files are safe; run sync again to resume.",
        );
      }
      throw error;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  } finally {
    await unlockState();
  }
}

main().catch((error: unknown) => {
  // Network exceptions can contain cookies, signed URLs, or page contents.
  const argumentError =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS");
  console.error(
    argumentError
      ? "Invalid arguments. Run node src/cli.ts --help for usage."
      : error instanceof DownloadError
        ? error.message
        : "The downloader stopped. Check your connection and directory permissions; then retry. No raw error details were logged.",
  );
  process.exitCode = 1;
});
