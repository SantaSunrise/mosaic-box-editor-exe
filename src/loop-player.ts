type PlayerEvents = {
  change: (video: HTMLVideoElement, event: string) => void;
  error: (error: unknown) => void;
};

/** Two decoders alternate at the media end; only the visible decoder is audible.
 * The standby stays paused on frame zero. No frames are cut to hide a seek.
 */
export class LoopPlayer {
  private current: HTMLVideoElement;
  private source = "";
  private enabled = false;
  private wantedPlaying = false;
  private muted = false;
  private volume = 1;
  private rate = 1;
  private revision = 0;
  private switching = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private frameOwner: HTMLVideoElement | undefined;
  private endDeadline: number | undefined;
  private readonly videos: readonly [HTMLVideoElement, HTMLVideoElement];
  private readonly events: PlayerEvents;

  constructor(
    videos: readonly [HTMLVideoElement, HTMLVideoElement],
    events: PlayerEvents,
  ) {
    this.videos = videos;
    this.events = events;
    this.current = videos[0];
    for (const video of videos) {
      video.loop = false;
      video.preload = "auto";
      video.playsInline = true;
      for (const event of [
        "play",
        "playing",
        "pause",
        "ended",
        "seeking",
        "seeked",
        "waiting",
        "loadedmetadata",
        "loadeddata",
        "timeupdate",
        "error",
      ]) {
        video.addEventListener(event, () => this.handle(video, event));
      }
    }
    this.showCurrent();
  }

  get active() {
    return this.current;
  }
  get looping() {
    return this.enabled;
  }
  get paused() {
    return !this.wantedPlaying;
  }
  private get standby() {
    return this.videos.find((video) => video !== this.current)!;
  }

  private showCurrent() {
    for (const video of this.videos) {
      const active = video === this.current;
      video.style.opacity = active ? "1" : "0";
      video.setAttribute("aria-hidden", String(!active));
      video.muted = active ? this.muted : true;
      video.volume = this.volume;
      video.playbackRate = this.rate;
      video.defaultPlaybackRate = this.rate;
    }
  }

  private cancelBoundary() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.frame !== undefined)
      this.frameOwner?.cancelVideoFrameCallback(this.frame);
    this.frame = undefined;
    this.frameOwner = undefined;
    this.endDeadline = undefined;
  }

  private interrupt() {
    this.revision++;
    this.switching = false;
    this.cancelBoundary();
    this.standby.pause();
    this.standby.muted = true;
  }

  load(source: string | null) {
    this.wantedPlaying = false;
    this.interrupt();
    for (const video of this.videos) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    this.source = source ?? "";
    this.current = this.videos[0];
    this.showCurrent();
    this.events.change(this.current, "source");
    if (this.source) {
      this.current.src = this.source;
      this.current.load();
      this.prepare();
    }
  }

  private prepare() {
    const next = this.standby;
    next.pause();
    next.muted = true;
    if (!this.enabled || !this.source) return;
    if (next.getAttribute("src") !== this.source) {
      next.src = this.source;
      next.load();
    } else if (next.readyState >= 1 && next.currentTime !== 0) {
      next.currentTime = 0;
    }
    next.playbackRate = this.rate;
  }

  setLoop(enabled: boolean) {
    this.interrupt();
    this.enabled = enabled;
    if (enabled) {
      this.prepare();
      this.watch();
    } else {
      this.standby.removeAttribute("src");
      this.standby.load();
      if (this.current.ended) {
        this.wantedPlaying = false;
        this.events.change(this.current, "ended");
      }
    }
  }

  async play() {
    if (!this.source) return;
    const revision = this.revision;
    this.wantedPlaying = true;
    try {
      await this.current.play();
      if (revision === this.revision && this.wantedPlaying) this.watch();
    } catch (error) {
      if (revision !== this.revision) return;
      this.wantedPlaying = false;
      this.events.change(this.current, "pause");
      this.events.error(error);
    }
  }

  pause() {
    this.wantedPlaying = false;
    this.interrupt();
    this.current.pause();
    this.prepare();
    this.events.change(this.current, "pause");
  }

  seek(time: number) {
    this.interrupt();
    this.prepare();
    this.current.currentTime = Math.max(
      0,
      Math.min(this.current.duration || 0, time),
    );
    if (this.wantedPlaying && this.current.paused) void this.play();
  }

  setRate(rate: number) {
    this.interrupt();
    this.rate = rate;
    this.showCurrent();
    this.prepare();
    this.watch();
    if (this.wantedPlaying && this.current.paused) void this.play();
  }

  setVolume(volume: number, muted = this.muted) {
    this.volume = volume;
    this.muted = muted;
    this.showCurrent();
    this.events.change(this.current, "volumechange");
  }

  private handle(video: HTMLVideoElement, event: string) {
    if (video !== this.current || this.switching) return;
    // The media clock may end before the last composited frame has completed
    // its display interval. Keep that frame visible until its deadline.
    if (event === "pause" && video.ended && this.enabled && this.wantedPlaying)
      return;
    if (event === "seeking" || event === "waiting" || event === "pause")
      this.cancelBoundary();
    if (event === "playing" || event === "seeked") this.watch();
    if (event === "ended") {
      if (this.enabled && this.wantedPlaying) {
        this.finishAtDeadline();
        return;
      }
      this.wantedPlaying = false;
    }
    if (event === "error") {
      this.pause();
      this.events.error(video.error?.message || "動画を再生できませんでした");
    }
    this.events.change(video, event);
  }

  private watch() {
    this.cancelBoundary();
    const video = this.current;
    if (
      !this.enabled ||
      !this.wantedPlaying ||
      video.paused ||
      video.seeking ||
      this.switching
    )
      return;
    const revision = this.revision;
    const schedule = (deadline: number) => {
      const remaining = deadline - performance.now();
      if (remaining < 250 && remaining >= -100) {
        this.endDeadline = deadline;
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () => {
            if (
              revision === this.revision &&
              this.wantedPlaying &&
              this.enabled
            )
              void this.advance();
          },
          Math.max(0, remaining),
        );
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      const frame = (_: number, metadata: VideoFrameCallbackMetadata) => {
        if (revision !== this.revision || video !== this.current) return;
        // Display timestamps preserve the final frame's duration, even when the
        // main thread callback runs late. Include any audio tail in duration.
        schedule(
          metadata.expectedDisplayTime +
            ((video.duration - metadata.mediaTime) / this.rate) * 1000,
        );
        this.frameOwner = video;
        this.frame = video.requestVideoFrameCallback(frame);
      };
      this.frameOwner = video;
      this.frame = video.requestVideoFrameCallback(frame);
    }
    // Also covers browsers without frame callbacks and seeking right to EOF.
    if (Number.isFinite(video.duration)) {
      this.timer = setTimeout(
        () => {
          if (revision !== this.revision) return;
          if (video.readyState >= 3 && !video.seeking && this.wantedPlaying) {
            if (video.currentTime >= video.duration || video.ended)
              this.finishAtDeadline();
            else this.watch();
          }
        },
        Math.max(0, ((video.duration - video.currentTime) / this.rate) * 1000),
      );
    }
  }

  private finishAtDeadline() {
    const remaining =
      (this.endDeadline ?? performance.now()) - performance.now();
    if (remaining > 0) {
      clearTimeout(this.timer);
      const revision = this.revision;
      this.timer = setTimeout(() => {
        if (revision === this.revision) void this.advance();
      }, remaining);
    } else void this.advance();
  }

  private async advance() {
    if (!this.enabled || !this.wantedPlaying || this.switching) return;
    this.cancelBoundary();
    const previous = this.current;
    const next = this.standby;
    if (
      next.readyState < 3 ||
      next.seeking ||
      next.currentTime > 0.001 ||
      next.error
    ) {
      // Slow disks/unsupported decoders keep the ordinary loop as a fallback.
      previous.currentTime = 0;
      this.prepare();
      await this.play();
      return;
    }
    this.switching = true;
    const revision = this.revision;
    try {
      next.muted = true;
      await next.play();
      if (revision !== this.revision) return;
      previous.muted = true;
      previous.pause();
      this.current = next;
      this.switching = false;
      this.showCurrent();
      this.events.change(next, "swap");
      this.prepare();
      this.watch();
    } catch {
      if (revision !== this.revision) return;
      this.switching = false;
      next.pause();
      previous.currentTime = 0;
      await this.play();
    }
  }
}
