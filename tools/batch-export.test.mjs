import assert from "node:assert/strict";
import test from "node:test";
import { pendingExports, runBatch } from "../src/batch-export.ts";

test("only saved, unexported clips enter the batch, including legacy rectangles", () => {
  const entries = [
    { exported: false, box: null },
    { exported: false, box: { mask: [{}] } },
    { exported: true, stale: true, box: { mask: [{}] } },
    { exported: false, box: { box: [0, 0, 1, 1] } },
    { exported: false, box: { mask: [] } },
  ];
  assert.deepEqual(pendingExports(entries), [entries[1], entries[3]]);
});
test("runs sequentially and continues after a failure", async () => {
  let active = 0;
  const order = [];
  const report = await runBatch([1, 2, 3], {
    cancelled: () => false,
    progress: () => {},
    exportItem: async (item) => {
      assert.equal(active++, 0);
      order.push(item);
      await Promise.resolve();
      active--;
      if (item === 2) throw Error("failed");
    },
  });
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(report.completed, [1, 3]);
  assert.equal(report.failed[0].item, 2);
  assert.equal(report.remaining, 0);
});
test("cancel completes the current clip and leaves the rest untouched", async () => {
  let cancelled = false;
  const order = [];
  const report = await runBatch([1, 2, 3], {
    cancelled: () => cancelled,
    progress: () => {},
    exportItem: async (item) => {
      order.push(item);
      cancelled = true;
    },
  });
  assert.deepEqual(order, [1]);
  assert.equal(report.remaining, 2);
});
test("concurrency limits running items, keeps counts exact and honours cancel", async () => {
  let active = 0;
  let peak = 0;
  const progress = [];
  const report = await runBatch([1, 2, 3, 4, 5, 6, 7], {
    concurrency: 3,
    cancelled: () => false,
    progress: (done, total, item) => progress.push([done, total, item]),
    exportItem: async (item) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5 * (8 - item)));
      active--;
      if (item === 4) throw Error("failed");
    },
  });
  assert.equal(peak, 3);
  assert.equal(report.completed.length, 6);
  assert.equal(report.failed[0].item, 4);
  assert.equal(report.remaining, 0);
  assert.deepEqual(progress.at(-1), [7, 7, null]);

  let cancelled = false;
  const started = [];
  const stopped = await runBatch([1, 2, 3, 4, 5, 6], {
    concurrency: 2,
    cancelled: () => cancelled,
    progress: () => {},
    exportItem: async (item) => {
      started.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      cancelled = true;
    },
  });
  assert.deepEqual(started, [1, 2]);
  assert.equal(stopped.completed.length, 2);
  assert.equal(stopped.remaining, 4);
});
