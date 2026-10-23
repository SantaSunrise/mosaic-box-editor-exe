// Video library helpers: the folder name shown in the header and the lazy
// thumbnail loader. No DOM access, so the Node tests can cover them.

/** Last folder of a path (either separator, trailing separators ignored). */
export function folderName(path: string) {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export type ThumbnailLoader = {
  /** Resolves to a data URL, or null when it could not be made (cached too). */
  request(key: string): Promise<string | null>;
  /** Drops a request that has not started yet (the row scrolled away). */
  cancel(key: string): void;
  /** Already-loaded thumbnail, for synchronous rendering. */
  cached(key: string): string | null | undefined;
  clear(): void;
};

/**
 * Loads thumbnails at most `concurrency` at a time. Each key is loaded once
 * (failures included) and kept in memory. Rows asked for most recently go
 * first, because they are the ones on screen after a scroll.
 */
export function createThumbnailLoader(
  load: (key: string) => Promise<string>,
  concurrency = 3,
): ThumbnailLoader {
  const cache = new Map<string, string | null>();
  const waiting = new Map<
    string,
    { resolve: (value: string | null) => void; promise: Promise<string | null> }
  >();
  const running = new Map<string, Promise<string | null>>();
  let generation = 0;

  function pump() {
    while (running.size < concurrency && waiting.size) {
      const [key, entry] = [...waiting].at(-1)!;
      waiting.delete(key);
      const epoch = generation;
      const task = load(key)
        .catch(() => null)
        .then((value) => {
          if (epoch === generation) cache.set(key, value);
          return value;
        })
        .finally(() => {
          running.delete(key);
          pump();
        });
      running.set(key, task);
      void task.then(entry.resolve);
    }
  }

  return {
    request(key) {
      if (cache.has(key)) return Promise.resolve(cache.get(key)!);
      const active = running.get(key) ?? waiting.get(key)?.promise;
      if (active) {
        // Asked again: move to the front of the line.
        const entry = waiting.get(key);
        if (entry) {
          waiting.delete(key);
          waiting.set(key, entry);
        }
        return active;
      }
      let resolve!: (value: string | null) => void;
      const promise = new Promise<string | null>((r) => (resolve = r));
      waiting.set(key, { resolve, promise });
      pump();
      return promise;
    },
    cancel(key) {
      // Left pending on purpose: a cancelled promise is never awaited again,
      // and a later request() for the same key starts fresh.
      waiting.delete(key);
    },
    cached: (key) => cache.get(key),
    clear() {
      generation++;
      cache.clear();
      waiting.clear();
    },
  };
}
