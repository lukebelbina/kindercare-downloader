# Working on KinderCare downloader

- Use pnpm, Node, TypeScript, Zod, and native ESM. Keep this a standalone local CLI.
- Read README.md before changing download behavior. Run `pnpm check` for code changes.
- Never commit or log credentials, cookies, signed media URLs, real API responses, child
  names, or downloaded media. Use synthetic test data. Keep traces and screenshots off.
- Login and media directories belong outside the source tree. Preserve restrictive file
  permissions, atomic writes, non-overwrite behavior, and checksum verification.
- Only request data available to the signed-in parent. Never enumerate account/activity IDs.
- Keep pagination explicit. Errors and safety limits must never report a complete archive.
- Do not publish the repository or upload media unless explicitly asked.

## Helping a user download their photos

1. Work from this repository with Node 24 or newer. Install runtime dependencies with
   `npm install --omit=dev`. Development uses pnpm; users do not need pnpm.
2. Run `node src/cli.ts status` to inspect local setup. This is read-only, makes no network
   requests, and does not prove server authentication. Never read or print auth.json.
3. If login is needed, ask the user to run `node src/cli.ts login` in their own terminal.
   Let them enter credentials there. Never request passwords in chat, pass them as arguments,
   or capture the terminal while credentials are entered. There is no browser fallback.
4. Run `node src/cli.ts sync`. Default output is Pictures/Kindercare in the user's home.
   Quote custom paths, especially on Windows. Reuse --config PATH for saved folder and sync
   settings; CLI options override that JSON file. Keep the same --config, --state-dir and
   --output arguments across runs; CLI overrides are not persisted. Config-relative paths
   resolve beside the config file, CLI-relative paths from the current directory.
5. Exit code 0 plus the final "Finished the selected journal" message means sync reached
   the explicit end. A nonzero exit means incomplete; completed files are safe. Rerun the
   same command to resume. Do not claim a complete archive after an error or cancellation.
6. For expired login, return the login step to the user. For a changed destination file,
   explain the conflict and have the user move it aside. Never delete user media to unblock
   sync. Remove stale locks only after establishing that no downloader is using them.

Login defaults to all accessible children. Only use --journal with login when the user
provides a child journal/Entries URL. Do not discover IDs by enumeration. Log only safe
counts and fixed errors; never inspect real photos or raw API responses for diagnostics.
