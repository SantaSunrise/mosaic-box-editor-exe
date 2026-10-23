import assert from "node:assert/strict";
import test from "node:test";
import { createThumbnailLoader, folderName } from "../src/library.ts";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("the folder name is the last part of either kind of path", () => {
  assert.equal(folderName("C:\\Users\\owner\\videos\\shoot3"), "shoot3");
  assert.equal(folderName("/home/a/b/"), "b");
  assert.equal(folderName("D:\\"), "D:");
  assert.equal(folderName("single"), "single");
  assert.equal(folderName(""), "");
});

test("thumbnails load at most three at a time and each only once", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const loader = createThumbnailLoader(async (key) => {
    calls.push(key);
    peak = Math.max(peak, ++active);
    await tick(5);
    active--;
    return `data:${key}`;
  }, 3);
  const keys = Array.from({ length: 10 }, (_, i) => `v${i}`);
  const urls = await Promise.all(
    [...keys, ...keys].map((k) => loader.request(k)),
  );
  assert.equal(peak, 3);
  assert.equal(calls.length, 10);
  assert.deepEqual(
    urls.slice(0, 10),
    keys.map((k) => `data:${k}`),
  );
  assert.equal(loader.cached("v4"), "data:v4");
  assert.equal(loader.cached("unknown"), undefined);
  // Cached: no new work.
  assert.equal(await loader.request("v4"), "data:v4");
  assert.equal(calls.length, 10);
});

test("a failed thumbnail resolves to null, is remembered and does not stall the queue", async () => {
  let calls = 0;
  const loader = createThumbnailLoader(async (key) => {
    calls++;
    if (key === "bad") throw new Error("ffmpeg failed");
    return "ok";
  }, 1);
  const [bad, good] = await Promise.all([
    loader.request("bad"),
    loader.request("good"),
  ]);
  assert.equal(bad, null);
  assert.equal(good, "ok");
  assert.equal(await loader.request("bad"), null);
  assert.equal(calls, 2);
});

test("rows scrolled away before starting are dropped; the newest request goes first", async () => {
  const started = [];
  const release = [];
  const loader = createThumbnailLoader(
    (key) =>
      new Promise((resolve) => {
        started.push(key);
        release.push(() => resolve(`data:${key}`));
      }),
    1,
  );
  void loader.request("a"); // starts at once
  void loader.request("b");
  void loader.request("c");
  void loader.request("d");
  loader.cancel("b");
  assert.deepEqual(started, ["a"]);
  release.shift()();
  await tick();
  // d was asked for after c, so it is on screen now and goes first; b is gone.
  assert.deepEqual(started, ["a", "d"]);
  release.shift()();
  await tick();
  assert.deepEqual(started, ["a", "d", "c"]);
  release.shift()();
  await tick();
  assert.equal(loader.cached("b"), undefined);
});

test("clearing forgets thumbnails so a changed folder is loaded again", async () => {
  let calls = 0;
  const loader = createThumbnailLoader(async () => `data:${++calls}`, 3);
  assert.equal(await loader.request("a"), "data:1");
  loader.clear();
  assert.equal(loader.cached("a"), undefined);
  assert.equal(await loader.request("a"), "data:2");
});
