/** Previews a timeline on a canvas, using one hidden media element per source file. */
import { signal } from '@angular/core';
import { mediaUrl } from '../../core/media';
import { clamp } from '../../core/util';
import {
  clipLength,
  cropOf,
  drawOverlay,
  locate,
  offsetOf,
  totalLength,
  type Clip,
  type VideoDoc,
} from './timeline';

export class Player {
  readonly time = signal(0);
  readonly playing = signal(false);
  private readonly videos = new Map<string, HTMLVideoElement>();
  private readonly images = new Map<string, HTMLImageElement>();
  private music: { id: string; element: HTMLAudioElement } | null = null;
  private frame = 0;
  private lastTick = 0;
  private activeVideo: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly doc: () => VideoDoc;

  constructor(doc: () => VideoDoc) {
    this.doc = doc;
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    if (canvas) this.sync(true);
  }

  private video(id: string): HTMLVideoElement {
    let element = this.videos.get(id);
    if (!element) {
      element = document.createElement('video');
      element.preload = 'auto';
      element.playsInline = true;
      element.src = mediaUrl(id);
      element.addEventListener('seeked', () => this.draw());
      element.addEventListener('loadeddata', () => this.sync(true));
      this.videos.set(id, element);
    }
    return element;
  }

  private image(id: string): HTMLImageElement {
    let element = this.images.get(id);
    if (!element) {
      element = new Image();
      element.onload = () => this.draw();
      element.src = mediaUrl(id);
      this.images.set(id, element);
    }
    return element;
  }

  private current(): { clip: Clip; sourceTime: number } | null {
    const doc = this.doc();
    const at = locate(doc.clips, this.time());
    return at && { clip: doc.clips[at.index]!, sourceTime: at.sourceTime };
  }

  seek(time: number): void {
    this.time.set(clamp(time, 0, totalLength(this.doc().clips)));
    this.sync(true);
  }

  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    const total = totalLength(this.doc().clips);
    if (!total) return;
    if (this.time() >= total - 0.05) this.time.set(0);
    this.playing.set(true);
    this.lastTick = performance.now();
    this.sync(true);
    const tick = (now: number) => {
      if (!this.playing()) return;
      this.advance((now - this.lastTick) / 1000);
      this.lastTick = now;
      if (this.playing()) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.frame);
    this.videos.forEach((v) => v.pause());
    this.music?.element.pause();
    this.activeVideo = null;
    this.draw();
  }

  /** Moves the playhead by wall-clock time, letting a playing video lead when it can. */
  private advance(elapsed: number): void {
    const doc = this.doc();
    const total = totalLength(doc.clips);
    const at = locate(doc.clips, this.time());
    if (!at) return this.pause();
    const clip = doc.clips[at.index]!;
    const offset = offsetOf(doc.clips, at.index);
    let next = this.time() + elapsed;
    if (clip.kind === 'video') {
      const element = this.video(clip.mediaId);
      if (!element.paused && !element.seeking && element.readyState >= 2) {
        next = offset + (element.currentTime - clip.start) / clip.speed;
      } else if (element.seeking || (element.readyState < 2 && !element.error)) {
        next = this.time();
      }
      if (element.ended) next = offset + clipLength(clip);
    }
    if (next >= total - 0.02) {
      this.time.set(total);
      return this.pause();
    }
    // Step just past the boundary so the next clip is the one located.
    if (next >= offset + clipLength(clip) - 0.02) {
      this.time.set(offset + clipLength(clip) + 0.001);
      this.sync(true);
    } else {
      this.time.set(Math.max(offset, next));
      this.sync(false);
    }
  }

  /** Brings the media elements in line with the playhead, then redraws. */
  sync(force: boolean): void {
    const now = this.current();
    const wanted = now?.clip.kind === 'video' ? this.video(now.clip.mediaId) : null;
    this.videos.forEach((v) => {
      if (v !== wanted && !v.paused) v.pause();
    });
    if (now && wanted) {
      const { clip, sourceTime } = now;
      wanted.playbackRate = clamp(clip.speed, 0.25, 4);
      wanted.muted = clip.muted;
      wanted.volume = clamp(clip.volume, 0, 1);
      if (
        force ||
        wanted !== this.activeVideo ||
        Math.abs(wanted.currentTime - sourceTime) > 0.35
      ) {
        if (Math.abs(wanted.currentTime - sourceTime) > 0.04) wanted.currentTime = sourceTime;
      }
      if (this.playing() && wanted.paused && !wanted.ended) wanted.play().catch(() => this.pause());
      this.activeVideo = wanted;
    }
    this.syncMusic(force);
    this.draw();
  }

  private syncMusic(force: boolean): void {
    const music = this.doc().music;
    if (this.music && this.music.id !== music?.mediaId) {
      this.music.element.pause();
      this.music = null;
    }
    if (!music) return;
    this.music ??= { id: music.mediaId, element: new Audio(mediaUrl(music.mediaId)) };
    const element = this.music.element;
    element.loop = true;
    element.volume = clamp(music.volume, 0, 1);
    const target = element.duration > 0 ? this.time() % element.duration : this.time();
    if (force || Math.abs(element.currentTime - target) > 0.5) element.currentTime = target;
    if (this.playing() && element.paused) element.play().catch(() => undefined);
    if (!this.playing()) element.pause();
  }

  draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const doc = this.doc();
    const g = canvas.getContext('2d')!;
    const { width, height } = canvas;
    g.filter = 'none';
    g.fillStyle = '#000';
    g.fillRect(0, 0, width, height);
    const now = this.current();
    if (now) {
      const { clip } = now;
      const source = clip.kind === 'video' ? this.video(clip.mediaId) : this.image(clip.mediaId);
      const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      if (sw && sh) {
        const crop = cropOf(clip) ?? { x: 0, y: 0, w: 1, h: 1 };
        const cw = sw * crop.w;
        const ch = sh * crop.h;
        const turned = clip.rotate % 180 !== 0;
        const fit = Math.min(width / (turned ? ch : cw), height / (turned ? cw : ch));
        g.save();
        // These filters approximate FFmpeg's result for preview purposes.
        g.filter = [
          `brightness(${1 + clip.brightness})`,
          `contrast(${clip.contrast})`,
          `saturate(${clip.saturation})`,
          clip.hue ? `hue-rotate(${clip.hue}deg)` : '',
          clip.grayscale ? 'grayscale(1)' : '',
          clip.sepia ? `sepia(${clip.sepia})` : '',
          clip.invert ? 'invert(1)' : '',
          clip.blur ? `blur(${(clip.blur * width) / doc.width}px)` : '',
        ].join(' ');
        g.translate(width / 2, height / 2);
        g.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
        g.rotate((clip.rotate * Math.PI) / 180);
        g.drawImage(
          source,
          sw * crop.x,
          sh * crop.y,
          cw,
          ch,
          (-cw * fit) / 2,
          (-ch * fit) / 2,
          cw * fit,
          ch * fit,
        );
        g.restore();
        this.frameEffects(g, clip, width, height, doc.width);
      }
    }
    for (const overlay of doc.overlays) {
      if (this.time() >= overlay.start && this.time() <= overlay.end)
        drawOverlay(g, overlay, width, height);
    }
    const total = totalLength(doc.clips);
    const fade = Math.min(
      doc.fadeIn > 0 ? this.time() / doc.fadeIn : 1,
      doc.fadeOut > 0 && this.playing() ? (total - this.time()) / doc.fadeOut : 1,
    );
    if (this.playing() && fade < 1) {
      g.fillStyle = `rgba(0,0,0,${1 - clamp(fade, 0, 1)})`;
      g.fillRect(0, 0, width, height);
    }
  }

  private scratch: HTMLCanvasElement | null = null;

  /** Effects FFmpeg applies to the whole finished frame. */
  private frameEffects(
    g: CanvasRenderingContext2D,
    clip: Clip,
    width: number,
    height: number,
    outputWidth: number,
  ): void {
    g.filter = 'none';
    if ((clip.pixelate ?? 0) > 1) {
      const block = Math.max(1, (clip.pixelate * width) / outputWidth);
      const small = (this.scratch ??= document.createElement('canvas'));
      small.width = Math.max(2, Math.round(width / block));
      small.height = Math.max(2, Math.round(height / block));
      small.getContext('2d')!.drawImage(g.canvas, 0, 0, small.width, small.height);
      g.imageSmoothingEnabled = false;
      g.drawImage(small, 0, 0, width, height);
      g.imageSmoothingEnabled = true;
    }
    if ((clip.vignette ?? 0) > 0) {
      const radius = Math.hypot(width, height) / 2;
      const shade = g.createRadialGradient(
        width / 2,
        height / 2,
        radius * 0.25,
        width / 2,
        height / 2,
        radius,
      );
      shade.addColorStop(0, 'rgba(0,0,0,0)');
      shade.addColorStop(1, `rgba(0,0,0,${0.95 * clip.vignette})`);
      g.fillStyle = shade;
      g.fillRect(0, 0, width, height);
    }
  }

  destroy(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.frame);
    for (const element of [...this.videos.values(), ...(this.music ? [this.music.element] : [])]) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.videos.clear();
    this.images.clear();
    this.music = null;
    this.canvas = null;
  }
}
