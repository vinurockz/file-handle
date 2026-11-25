/** Draws and plays a movie. The preview and the export each use their own instance. */
import { signal } from '@angular/core';
import { mediaUrl } from '../../core/media';
import { clamp } from '../../core/util';
import { drawBand } from '../../shared/band';
import { wrapText } from '../image/text-layout';
import {
  animationState,
  movieBand,
  ASPECTS,
  movieLength,
  sceneAt,
  transitionState,
  type Aspect,
  type Bubble,
  type MovieBand,
  type Scene,
  type SceneObject,
} from './model';

export interface MovieData {
  aspect: Aspect;
  background: string;
  clips: Scene[];
  header: MovieBand;
  footer: MovieBand;
  musicMediaId: string | null;
  musicVolume: number;
}

export interface Placed {
  object: SceneObject;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Source = HTMLVideoElement | HTMLImageElement;

export class MovieEngine {
  readonly time = signal(0);
  readonly playing = signal(false);
  private readonly sources = new Map<string, Source>();
  private music: { id: string; element: HTMLAudioElement } | null = null;
  private frame = 0;
  private last = 0;
  private canvas: HTMLCanvasElement | null = null;
  /** Objects drawn in the latest frame, for clicking and dragging on the canvas. */
  placed: Placed[] = [];
  onFinished: (() => void) | null = null;
  private audio: { context: AudioContext; output: MediaStreamAudioDestinationNode } | null = null;
  private readonly movie: () => MovieData;

  constructor(movie: () => MovieData) {
    this.movie = movie;
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.sync(true);
  }

  /** Routes all sound into a stream for recording. Must be called before any media is created. */
  captureAudio(context: AudioContext): MediaStream {
    this.audio = { context, output: context.createMediaStreamDestination() };
    // Chrome writes nothing at all while an audio track has no data, so a silent movie still needs a signal.
    const silence = context.createConstantSource();
    silence.offset.value = 0;
    silence.connect(this.audio.output);
    silence.start();
    return this.audio.output.stream;
  }

  private route(element: HTMLMediaElement): void {
    if (this.audio) this.audio.context.createMediaElementSource(element).connect(this.audio.output);
  }

  private source(object: SceneObject): Source {
    const key = `${object.id}:${object.mediaId}`;
    let element = this.sources.get(key);
    if (element) return element;
    if (object.kind === 'video') {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      video.src = mediaUrl(object.mediaId);
      video.addEventListener('seeked', () => this.draw());
      video.addEventListener('loadeddata', () => this.sync(true));
      this.route(video);
      element = video;
    } else {
      const image = new Image();
      image.onload = () => this.draw();
      image.src = mediaUrl(object.mediaId);
      element = image;
    }
    this.sources.set(key, element);
    return element;
  }

  private soundtrack(): HTMLAudioElement | null {
    const id = this.movie().musicMediaId;
    if (this.music && this.music.id !== id) {
      this.music.element.pause();
      this.music = null;
    }
    if (!id) return null;
    if (!this.music) {
      const element = new Audio(mediaUrl(id));
      element.loop = true;
      element.preload = 'auto';
      this.route(element);
      this.music = { id, element };
    }
    return this.music.element;
  }

  /** Loads every file before recording, so the export has no blank frames. */
  async preload(): Promise<void> {
    const elements: (Source | HTMLAudioElement)[] = this.movie().clips.flatMap((s) =>
      s.objects.map((o) => this.source(o)),
    );
    const music = this.soundtrack();
    if (music) elements.push(music);
    await Promise.all(
      elements.map(
        (element) =>
          new Promise<void>((resolve, reject) => {
            const ready =
              element instanceof HTMLImageElement
                ? element.complete && element.naturalWidth > 0
                : element.readyState >= 3;
            if (ready) return resolve();
            const timer = setTimeout(
              () => reject(new Error('A media file took too long to load')),
              30_000,
            );
            const done = (ok: boolean) => () => {
              clearTimeout(timer);
              if (ok) resolve();
              else reject(new Error('A file used in this movie is missing or cannot be played'));
            };
            element.addEventListener(
              element instanceof HTMLImageElement ? 'load' : 'canplay',
              done(true),
              { once: true },
            );
            element.addEventListener('error', done(false), { once: true });
          }),
      ),
    );
  }

  seek(time: number): void {
    this.time.set(clamp(time, 0, movieLength(this.movie().clips)));
    this.sync(true);
  }

  play(): void {
    const total = movieLength(this.movie().clips);
    if (!total) return;
    if (this.time() >= total - 0.05) this.time.set(0);
    this.playing.set(true);
    this.last = performance.now();
    this.sync(true);
    const tick = (now: number) => {
      if (!this.playing()) return;
      // Cap the step so a stalled tab does not skip whole scenes.
      const next = this.time() + Math.min(0.25, Math.max(0, now - this.last) / 1000);
      this.last = now;
      if (next >= total) {
        this.time.set(total);
        this.pause();
        this.onFinished?.();
        return;
      }
      this.time.set(next);
      this.sync(false);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.frame);
    this.sources.forEach((s) => s instanceof HTMLVideoElement && s.pause());
    this.music?.element.pause();
    this.draw();
  }

  sync(force: boolean): void {
    const movie = this.movie();
    const at = sceneAt(movie.clips, this.time());
    const active = new Set<Source>();
    if (at) {
      for (const object of movie.clips[at.index]!.objects) {
        const element = this.source(object);
        if (
          !(element instanceof HTMLVideoElement) ||
          at.local < object.startSec ||
          at.local > object.endSec
        )
          continue;
        active.add(element);
        const duration = Number.isFinite(element.duration)
          ? element.duration
          : Number.MAX_SAFE_INTEGER;
        const wanted = Math.min(object.trimStart + at.local - object.startSec, duration);
        element.muted = object.muted;
        const drift = Math.abs(element.currentTime - wanted);
        if (drift > (force || !this.playing() ? 0.05 : 0.4)) element.currentTime = wanted;
        if (this.playing() && element.paused && wanted < duration - 0.05)
          element.play().catch(() => undefined);
      }
    }
    this.sources.forEach((s) => {
      if (s instanceof HTMLVideoElement && !active.has(s) && !s.paused) s.pause();
    });
    const music = this.soundtrack();
    if (music) {
      music.volume = clamp(movie.musicVolume, 0, 1);
      const wanted = music.duration > 0 ? this.time() % music.duration : this.time();
      if (force) music.currentTime = wanted;
      if (this.playing() && music.paused) music.play().catch(() => undefined);
      if (!this.playing()) music.pause();
    }
    this.draw();
  }

  draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const movie = this.movie();
    const { width, height } = ASPECTS[movie.aspect];
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const g = canvas.getContext('2d')!;
    g.fillStyle = movie.background || '#000000';
    g.fillRect(0, 0, width, height);
    const header = movieBand(movie.header);
    const footer = movieBand(movie.footer);
    const headerHeight = header.enabled ? header.size : 0;
    const footerHeight = footer.enabled ? footer.size : 0;
    const area = { x: 0, y: headerHeight, w: width, h: height - headerHeight - footerHeight };
    this.placed = [];
    const at = sceneAt(movie.clips, this.time());
    if (at) {
      const scene = movie.clips[at.index]!;
      // While paused, show the scene fully rather than mid-transition at its first frame.
      const state = this.playing()
        ? transitionState(scene, at.local)
        : { alpha: 1, dx: 0, dy: 0, scale: 1 };
      g.save();
      g.beginPath();
      g.rect(area.x, area.y, area.w, area.h);
      g.clip();
      g.globalAlpha = state.alpha;
      g.translate(width / 2 + state.dx * width, height / 2 + state.dy * height);
      g.scale(state.scale, state.scale);
      g.translate(-width / 2, -height / 2);
      for (const object of scene.objects) {
        if (at.local < object.startSec || at.local > object.endSec) continue;
        this.drawObject(g, object, area, at.local);
      }
      for (const bubble of scene.bubbles) {
        if (at.local >= bubble.startSec && at.local <= bubble.endSec && bubble.text.trim())
          this.drawBubble(g, bubble, area);
      }
      g.restore();
    }
    drawBand(g, header, 0, 0, width, headerHeight);
    drawBand(g, footer, 0, height - footerHeight, width, footerHeight);
  }

  private drawObject(
    g: CanvasRenderingContext2D,
    object: SceneObject,
    area: { x: number; y: number; w: number; h: number },
    local: number,
  ): void {
    const element = this.source(object);
    const sw = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
    const sh = element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
    if (!sw || !sh) return;
    let w: number;
    let h: number;
    let x = area.x + area.w / 2;
    let y = area.y + area.h / 2;
    if (object.fit === 'free') {
      w = object.width * area.w;
      h = (w * sh) / sw;
      x = area.x + object.x * area.w;
      y = area.y + object.y * area.h;
    } else {
      const scale = (object.fit === 'cover' ? Math.max : Math.min)(area.w / sw, area.h / sh);
      w = sw * scale;
      h = sh * scale;
    }
    this.placed.push({ object, x, y, w, h });
    const motion = animationState(object, local);
    g.save();
    g.translate(x + motion.dx, y + motion.dy);
    g.rotate(motion.angle);
    g.transform(1, 0, motion.skew, 1, 0, 0);
    g.scale(motion.scale, motion.scale);
    g.drawImage(element, -w / 2, -h / 2, w, h);
    g.restore();
  }

  private drawBubble(
    g: CanvasRenderingContext2D,
    bubble: Bubble,
    area: { x: number; y: number; w: number; h: number },
  ): void {
    g.font = `600 ${bubble.fontSize}px ${bubble.fontFamily}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lines = wrapText(bubble.text, area.w * 0.6, (t) => g.measureText(t).width);
    const lineHeight = bubble.fontSize * 1.25;
    const pad = bubble.fontSize * 0.55;
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2;
    const h = lines.length * lineHeight + pad;
    const speaker = this.placed.find((p) => p.object.id === bubble.objectId);
    let x = speaker ? speaker.x : area.x + bubble.x * area.w;
    let y = speaker ? speaker.y - speaker.h / 2 - h / 2 - 24 : area.y + bubble.y * area.h;
    x = clamp(x, area.x + w / 2 + 6, area.x + area.w - w / 2 - 6);
    y = clamp(y, area.y + h / 2 + 6, area.y + area.h - h / 2 - 24);
    g.fillStyle = bubble.bubbleColor;
    g.beginPath();
    g.roundRect(x - w / 2, y - h / 2, w, h, Math.min(24, h / 3));
    if (bubble.tail) {
      g.moveTo(x - 16, y + h / 2 - 1);
      g.lineTo(x - 4, y + h / 2 + 20);
      g.lineTo(x + 14, y + h / 2 - 1);
    }
    g.fill();
    g.fillStyle = bubble.textColor;
    lines.forEach((line, i) => g.fillText(line, x, y + (i - (lines.length - 1) / 2) * lineHeight));
  }

  destroy(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.frame);
    this.onFinished = null;
    const media: HTMLMediaElement[] = [...this.sources.values()].filter(
      (s): s is HTMLVideoElement => s instanceof HTMLVideoElement,
    );
    if (this.music) media.push(this.music.element);
    for (const element of media) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.sources.clear();
    this.music = null;
    this.canvas = null;
  }
}

export interface Recording {
  result: Promise<Blob | null>;
  cancel(): void;
}

/** Plays the movie once in real time while recording the canvas and its sound to WebM. */
export function recordMovie(movie: MovieData, onProgress: (fraction: number) => void): Recording {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    return {
      result: Promise.reject(
        new Error('This browser cannot record video. Use Chrome, Edge or Firefox.'),
      ),
      cancel: () => undefined,
    };
  }
  const snapshot = structuredClone(movie);
  const engine = new MovieEngine(() => snapshot);
  const context = new AudioContext();
  const sound = engine.captureAudio(context);
  const canvas = document.createElement('canvas');
  let cancelled = false;
  let stop: (() => void) | null = null;

  const result = (async (): Promise<Blob | null> => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let onVisibility: (() => void) | null = null;
    try {
      await context.resume();
      engine.attach(canvas);
      await engine.preload();
      if (cancelled) return null;
      engine.seek(0);
      const stream = canvas.captureStream(30);
      sound.getAudioTracks().forEach((track) => stream.addTrack(track));
      const mimeType = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ].find((t) => MediaRecorder.isTypeSupported(t));
      if (!mimeType) throw new Error('This browser cannot record WebM video');
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new Error('Recording failed'));
      });
      stop = () => {
        engine.pause();
        if (recorder.state !== 'inactive') recorder.stop();
      };
      engine.onFinished = () => setTimeout(() => stop?.(), 150);
      // Hidden tabs stop drawing, so pause recording until the tab is visible again.
      onVisibility = () => {
        if (recorder.state === 'inactive') return;
        if (document.hidden) {
          engine.pause();
          recorder.pause();
        } else if (recorder.state === 'paused') {
          recorder.resume();
          engine.play();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      const total = movieLength(snapshot.clips);
      timer = setInterval(() => onProgress(engine.time() / total), 200);
      recorder.start(500);
      engine.play();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      if (cancelled) return null;
      const recording = new Blob(chunks, { type: 'video/webm' });
      if (!recording.size)
        throw new Error('The browser recorded nothing. Keep this tab visible and try again.');
      return recording;
    } finally {
      clearInterval(timer);
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
      engine.destroy();
      void context.close();
    }
  })();

  return {
    result,
    cancel: () => {
      cancelled = true;
      stop?.();
    },
  };
}
