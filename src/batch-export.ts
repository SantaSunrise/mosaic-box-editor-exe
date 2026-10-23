export type BatchReport<T> = {
  completed: T[];
  failed: { item: T; error: string }[];
  remaining: number;
};

// One item at a time unless `concurrency` says otherwise (exports use one
// encoder; the AI check overlaps files). A failure doesn't prevent unrelated
// items from running. Cancelling stops starting new items; those already
// running finish. `completed` / `failed` are in completion order.
export async function runBatch<T>(
  items: T[],
  options: {
    exportItem: (item: T) => Promise<unknown>;
    cancelled: () => boolean;
    progress: (done: number, total: number, current: T | null) => void;
    concurrency?: number;
  },
): Promise<BatchReport<T>> {
  const report: BatchReport<T> = {
    completed: [],
    failed: [],
    remaining: items.length,
  };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (options.cancelled()) return;
      const item = items[next++];
      options.progress(items.length - report.remaining, items.length, item);
      try {
        await options.exportItem(item);
        report.completed.push(item);
      } catch (error) {
        report.failed.push({ item, error: String(error) });
      }
      report.remaining--;
      options.progress(items.length - report.remaining, items.length, null);
    }
  };
  const workers = Math.max(1, Math.floor(options.concurrency ?? 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return report;
}

export function pendingExports<
  T extends {
    exported: boolean;
    box: { mask?: unknown[]; box?: number[] } | null;
  },
>(entries: T[]): T[] {
  return entries.filter(
    (entry) =>
      !entry.exported &&
      Boolean(entry.box?.mask?.length || entry.box?.box?.length === 4),
  );
}
