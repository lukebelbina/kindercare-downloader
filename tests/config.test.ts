import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { folderPath } from "../src/config.ts";

test("home paths expand even when quoted and relative paths use their base", () => {
  assert.equal(folderPath("~"), homedir());
  assert.equal(folderPath("~/Family Photos"), join(homedir(), "Family Photos"));
  assert.equal(
    folderPath("~\\Family Photos"),
    join(homedir(), "Family Photos"),
  );
  assert.equal(folderPath("photos", homedir()), resolve(homedir(), "photos"));
});
