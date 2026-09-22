import assert from "node:assert/strict";
import test from "node:test";
import { LoopPlayer } from "../src/loop-player.ts";

class Video extends EventTarget {
  style = {};
  attributes = new Map();
  callbacks = new Map();
  sequence = 0;
  currentTime = 0;
  duration = 2;
  readyState = 4;
  seeking = false;
  paused = true;
  ended = false;
  muted = false;
  volume = 1;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  error = null;
  playGate = null;
  plays = 0;
  set src(value) {
    this.attributes.set("src", value);
  }
  get src() {
    return this.attributes.get("src") || "";
  }
  setAttribute(k, v) {
    this.attributes.set(k, v);
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  load() {
    this.currentTime = 0;
    this.ended = false;
  }
  play() {
    this.plays++;
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    return this.playGate ?? Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
  }
  requestVideoFrameCallback(fn) {
    const id = ++this.sequence;
    this.callbacks.set(id, fn);
    return id;
  }
  cancelVideoFrameCallback(id) {
    this.callbacks.delete(id);
  }
  present(time) {
    this.currentTime = time;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((fn) =>
      fn(performance.now(), {
        mediaTime: time,
        expectedDisplayTime: performance.now(),
      }),
    );
  }
  end() {
    this.currentTime = this.duration;
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function setup(t) {
  const a = new Video(),
    b = new Video(),
    changes = [];
  const player = new LoopPlayer([a, b], {
    change: (video, event) => changes.push({ video, event }),
    error: (error) => {
      throw error;
    },
  });
  t.after(() => player.pause());
  player.load("clip.mp4");
  return { a, b, player, changes };
}

test("alternates prepared players without seeking the outgoing clip early; only one is audible", async (t) => {
  const { a, b, player } = setup(t);
  player.setLoop(true);
  player.setVolume(0.4, false);
  await player.play();
  assert.equal(b.paused, true);
  assert.equal(b.currentTime, 0);
  assert.equal(b.muted, true);
  a.end();
  await settle();
  assert.equal(player.active, b);
  assert.equal(a.paused, true);
  assert.equal(a.muted, true);
  assert.equal(b.muted, false);
  assert.equal(b.volume, 0.4);
  b.end();
  await settle();
  assert.equal(player.active, a);
  assert.equal(b.muted, true);
});
test("a last-frame deadline retains the final frame for its remaining duration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { a, b, player } = setup(t);
  player.setLoop(true);
  await player.play();
  a.present(1.95);
  a.end(); // The media clock can finish before the final display interval.
  t.mock.timers.tick(25);
  await settle();
  assert.equal(player.active, a);
  assert.equal(b.plays, 0);
  t.mock.timers.tick(30);
  await settle();
  assert.equal(player.active, b);
});
for (const action of ["pause", "seek", "source", "disable", "rate"])
  test(`${action} cancels an in-flight handoff`, async (t) => {
    const { a, b, player } = setup(t);
    player.setLoop(true);
    await player.play();
    let resolve;
    b.playGate = new Promise((r) => (resolve = r));
    a.end();
    if (action === "pause") player.pause();
    if (action === "seek") player.seek(0.7);
    if (action === "source") player.load("other.mp4");
    if (action === "disable") player.setLoop(false);
    if (action === "rate") player.setRate(2);
    resolve();
    await settle();
    assert.equal(player.active, a);
    assert.equal(b.paused, true);
    assert.equal(b.muted, true);
    if (action === "seek") assert.equal(a.currentTime, 0.7);
    if (action === "seek" || action === "rate") assert.equal(a.paused, false);
    if (action === "source") assert.equal(a.src, "other.mp4");
  });
test("rate and mute settings survive repeated switches; disabling loop releases standby", async (t) => {
  const { a, b, player } = setup(t);
  player.setLoop(true);
  player.setRate(1.5);
  player.setVolume(0.2, true);
  await player.play();
  a.end();
  await settle();
  assert.equal(b.playbackRate, 1.5);
  assert.equal(b.muted, true);
  player.setLoop(false);
  assert.equal(a.src, "");
  b.end();
  await settle();
  assert.equal(player.paused, true);
  assert.equal(player.active, b);
});

test("standby playback rejection keeps the visible decoder working", async (t) => {
  const { a, b, player } = setup(t);
  player.setLoop(true);
  await player.play();
  b.playGate = Promise.reject(new Error("decoder unavailable"));
  a.end();
  await settle();
  assert.equal(player.active, a);
  assert.equal(a.paused, false);
  assert.equal(b.muted, true);
});
test("an unavailable standby falls back to the current decoder", async (t) => {
  const { a, b, player } = setup(t);
  player.setLoop(true);
  await player.play();
  b.readyState = 1;
  a.end();
  await settle();
  assert.equal(player.active, a);
  assert.equal(a.currentTime, 0);
  assert.equal(a.paused, false);
});
