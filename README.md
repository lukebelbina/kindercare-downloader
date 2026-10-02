# KinderCare Downloader — bulk download photos and videos

**Download all available KinderCare photos and videos to your computer** with a free,
open-source command-line tool. Back up your child's daycare photo journal from the
KinderCare parent app through the parent website. Sign in from your terminal, download
in bulk, and rerun to save new files without downloading verified files again.
No subscription, hosted service, or downloader account.

- Terminal login with a hidden password; no browser extension or browser automation.
- Local photo and video backup with resumable downloads and checksum verification.
- Original files and embedded metadata preserved, with journal dates as a filesystem fallback.
- Designed for Windows, macOS, and Linux. Requires Node.js 24 or newer.

Live downloads have been verified on Linux. Windows and macOS use the same CLI and
portable filesystem APIs, but have not yet been tested directly.

Unofficial and not affiliated with KinderCare or Lillio. This uses the private endpoints
behind the parent website; changes to that website can require an adapter update.

## Setup

Install [Node.js 24 or newer](https://nodejs.org/en/download) (which includes npm). Download this repository using GitHub's
**Code → Download ZIP** and extract it, or clone it with Git. Open a terminal in the
extracted/cloned project directory. Check `node --version` reports `v24` or newer.
If `node` is not recognized, reopen your terminal after installing Node.js.

Run these commands in Windows PowerShell, macOS Terminal, or a Linux terminal:

```sh
npm install --omit=dev
node src/cli.ts login
node src/cli.ts sync
```

Wait for **"Finished the selected journal"** before treating the backup as complete.
Files appear in your home folder under `Pictures/Kindercare`. Repeat
`node src/cli.ts sync` whenever you want to download new photos.

Login prompts for your KinderCare email/username and a hidden password in the terminal.
It submits the website's login form with its CSRF token, verifies parent journal access,
and saves session cookies locally. The password is not saved or logged. Do not put it in
command arguments, environment variables, or a pipe. Login requires an interactive terminal.

By default, login selects the all-children journal. To select one child, copy their Entries
or photo-journal URL from the [KinderCare parent website](https://classroom.kindercare.com):

```sh
node src/cli.ts login --journal https://classroom.kindercare.com/accounts/123/activities
```

Replace the example URL with your own. No browser automation or browser installation is
required. Login challenges such as CAPTCHA, SSO, or additional verification are not supported;
if KinderCare requires one, login stops without saving a new session. Sign-in submissions
are not automatically retried.

Files go to `~/Pictures/Kindercare`. The downloader requests every page of the selected
journal until KinderCare returns an empty page. It uses the same image/video download
endpoints as the website's download buttons, rather than saving thumbnails or screenshots.

Photos are named `activity-<id>-image.jpg` (or their actual file type); videos use
`activity-<id>-video.mp4`. A ZIP response is preserved as a ZIP, without automatic extraction.
Files retain their original bytes and any embedded metadata. When KinderCare supplies a
journal timestamp (`list_date`, or `created_at` for older entries), sync records it as
`journalDate` in the manifest and sets the file's modification time to that instant. Photo importers such as Immich can use this
as a fallback when embedded capture dates are absent. A journal date is not necessarily
the time the camera took the photo. No EXIF metadata is added or replaced.

Rerunning sync also fills in journal dates and updates modification times for existing,
checksum-verified files, without downloading them again. Missing dates leave modification
times unchanged; malformed dates stop sync. Photos already imported into another app
may require a separate metadata update there. Captions and date folders are not exported.

## Using an AI coding agent

Open this repository in your agent and ask:

> Help me install this KinderCare photo downloader and back up all photos and videos.
> Follow AGENTS.md, keep my login and photos outside the repository, and let me enter
> my password directly in my terminal.

[AGENTS.md](AGENTS.md) describes setup, safe login, configuration, resuming, and how to
check that a download completed. No API key or developer account is required.

## Supported accounts

This tool supports the KinderCare parent journal at `classroom.kindercare.com`, using
your existing parent login. It downloads photos and videos your account can currently
access, including an all-children journal or a selected child's Entries tab.
It is not a general downloader for other daycare apps or standalone Lillio/HiMama accounts.

## Runtime dependencies

Login and sync run in Node alone. The only direct runtime dependencies are Zod (response
validation) and tough-cookie (cookie expiry, scoping, and refresh). No Playwright, Chromium,
TypeScript compiler, or build step is required. This is a source checkout; the project is
not yet published as an npm package.

Sessions from the earlier browser-based prototype are no longer supported. If you used that
prototype, run `node src/cli.ts login` again before your next sync; downloaded media and the
manifest can be reused.

If you use pnpm, `pnpm install --prod --frozen-lockfile`, `pnpm run login`, and `pnpm sync`
are equivalent commands. Use `pnpm run login`, since `pnpm login` is pnpm's registry command.

## Repeat backups

Run `node src/cli.ts sync` again. A local manifest records each completed file's size and SHA-256 hash.
Verified files are skipped. Missing files are fetched again. Modified files are reported
instead of overwritten; move them aside to let sync restore the server copy. Keep the
manifest with the media when moving or backing up the directory.

The selected journal can belong to one child or be the all-children journal. To select another
child, run `node src/cli.ts login --journal URL` again with their journal URL. Use the same output directory to avoid
downloading shared activities twice. The command only downloads what your parent account can
currently access; it cannot recover deleted photos or access revoked by your center.

```sh
node src/cli.ts sync --output "/path/to/private/backup"
node src/cli.ts sync --delay-ms 1000
node src/cli.ts --help
node src/cli.ts logout
```

On Windows, quote paths containing spaces, for example:

```powershell
node src/cli.ts sync --output "C:\Users\YourName\Pictures\KinderCare Backup"
```

On macOS/Linux, an external drive or folder with spaces also needs quotes:

```sh
node src/cli.ts sync --output "/Volumes/Family Backup/Kindercare"
```

Use `node src/cli.ts status` to see local configuration and whether unexpired cookies
exist. It does not contact KinderCare or confirm that the server still accepts the login.
Pass the same `--config`, `--state-dir`, and `--output` options you use for sync;
command-line overrides are not remembered between commands. Defaults use your OS user home directory (`~`).

For unattended backups, schedule `node src/cli.ts sync` using your operating system's
scheduler with this project as its working directory. A session can expire and require
interactive login again. There is no background service installed by this project.

## Folders and optional config

Folder and sync settings can be supplied directly:

```sh
node src/cli.ts sync --output "~/Pictures/Kindercare" --state-dir "~/.kindercare-downloader" --delay-ms 1000 --max-pages 10000
```

To reuse settings, create a JSON file outside the repository, for example
`~/kindercare-config.json`:

```json
{
  "output": "~/Pictures/Kindercare",
  "stateDir": "~/.kindercare-downloader",
  "delayMs": 1000,
  "maxPages": 10000
}
```

Every field is optional. Select the file explicitly with `--config`:

```sh
node src/cli.ts login --config "~/kindercare-config.json"
node src/cli.ts status --config "~/kindercare-config.json"
node src/cli.ts sync --config "~/kindercare-config.json"
node src/cli.ts sync --config "~/kindercare-config.json" --delay-ms 2000
```

| Argument | JSON field | Default |
| --- | --- | --- |
| `--output PATH` | `output` | `~/Pictures/Kindercare` |
| `--state-dir PATH` | `stateDir` | `~/.kindercare-downloader` |
| `--delay-ms NUMBER` | `delayMs` | `500` (250–60000) |
| `--max-pages NUMBER` | `maxPages` | `10000` (1–100000) |

Command-line arguments override the config file; omitted settings use defaults. Config
files are never discovered automatically. Missing, malformed, or unknown settings fail
with an error instead of silently selecting another folder. Use JSON numbers for numeric
settings, not quoted strings.

Relative paths in the config resolve from the config file's directory. Relative paths on
the command line resolve from the terminal's current directory. `~` expands to your home
directory even inside quotes. On Windows, JSON paths can use forward slashes, such as
`"C:/Users/YourName/Pictures/Kindercare"`; backslashes must be doubled in JSON.

Commands display the effective media and session folders. `status` also shows the delay
and page limit. Changing the media folder selects a separate archive; it does not move
existing downloads. Changing the session folder requires login there.

Keep credentials and cookies out of the config. The child journal remains a `login --journal URL` option, remembered in the session directory after successful login.

## Local data and privacy

- Login state is in `~/.kindercare-downloader/auth.json`, outside the source tree by default.
  Treat it like a password: it contains an authenticated session. `node src/cli.ts logout` removes
  the local saved login; it does not revoke other sessions on KinderCare.
- `session.json` in the same directory remembers your selected journal. Use `--state-dir`
  with both commands if you want another location or a separate parent account.
- Media and the download manifest stay in the output directory. No telemetry or upload
  service is added by the downloader. Login requests go only to KinderCare's classroom site.
- Session cookies are sent only to `classroom.kindercare.com`; CDN downloads receive no
  session cookies. Redirects are restricted to HTTPS on recognized KinderCare/Lillio and
  media-host domains. Unknown hosts stop the run instead of receiving credentials.
- Files/directories use owner-only permissions on POSIX systems. On Windows, store them in
  your private user directory and use your normal filesystem access controls. Local files
  are not additionally encrypted by this tool.
- Raw API responses, signed media URLs, screenshots, and browser traces are not written to
  the project. Logs contain counts and fixed error messages, not credentials or child names.
- The repository ignores common media, session, and temporary files. Keep custom output and
  session directories outside the repository, especially before publishing it.

## Failures and resuming

Downloads are sequential with a default 500 ms pause. HTTP 429 and server errors get bounded
retries. If the server requests a pause longer than one minute, sync stops and tells you how
long to wait before retrying. A failed run exits nonzero; completed files remain available for the next run.
Temporary files are not added to the manifest. Ctrl+C cancels network requests and retry
waits, then releases the directory locks.

On filesystems supporting hard links, completed media is published atomically. On exFAT,
FAT32, and other filesystems without hard links, an exclusive copy prevents overwriting
existing files. A hard crash during that copy can leave a partial destination file;
it is not recorded as complete. If the next sync reports a differing destination, move
that file aside and retry. Filesystem limits still apply (for example, available space). HTML login pages cannot be saved as photos.

The default safety limit is 10,000 pages. Hitting it reports an incomplete archive; increase
it with `--max-pages` if needed. Unexpected schemas or repeated pages also stop the run.

Only one process can use a state/output directory at a time. If the process is forcibly
killed or the machine loses power, remove `.download.lock` from those directories **after
checking no downloader is running**, then rerun sync. Leftover `*.part` files from a hard
crash can be deleted; they are never treated as completed downloads.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
```

TypeScript, native ESM, Zod, and tough-cookie. Node 24 runs the TypeScript directly; no
compiler or tsx is required at runtime. No database, server, or Docker required.
Tests use synthetic records and byte sequences, never real children's photos or sessions.
The adapter is in `src/journal.ts`; file transfer and verification are in `src/download.ts`.

For bug reports, include the fixed error message and whether the corresponding photo opens
on KinderCare's website. Do not attach cookies, auth files, signed URLs, raw API responses,
or photos of children. MIT licensed; see [LICENSE](LICENSE).
