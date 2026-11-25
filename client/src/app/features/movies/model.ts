/** A movie is a list of scenes; each scene places pictures, videos and timed speech bubbles on a canvas. */
import { clamp, uid } from '../../core/util';
import { createBand, type Band } from '../../shared/band';

export type Aspect = '16:9' | '9:16' | '1:1' | '4:3';
export type Transition =
  'none' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down' | 'zoom';
export type AnimationType = 'none' | 'kenburns-in' | 'kenburns-out' | 'shake' | 'tilt3d';

export const ASPECTS: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 960, height: 960 },
  '4:3': { width: 1024, height: 768 },
};
export const TRANSITIONS: Transition[] = [
  'none',
  'fade',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  'zoom',
];
export const ANIMATIONS: AnimationType[] = [
  'none',
  'kenburns-in',
  'kenburns-out',
  'shake',
  'tilt3d',
];
export const TRANSITION_SECONDS = 0.6;

export interface SceneObject {
  id: string;
  kind: 'video' | 'image';
  mediaId: string;
  /** Centre, as fractions of the area between header and footer. */
  x: number;
  y: number;
  /** Fraction of the area's width; height follows the media's shape. */
  width: number;
  /** `cover` and `contain` fill the frame and ignore x, y and width. */
  fit: 'free' | 'cover' | 'contain';
  trimStart: number;
  muted: boolean;
  animation: AnimationType;
  intensity: number;
  startSec: number;
  endSec: number;
}

export interface Bubble {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  /** When set, the bubble floats above that object. */
  objectId: string | null;
  x: number;
  y: number;
  bubbleColor: string;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  tail: boolean;
}

export interface Scene {
  id: string;
  duration: number;
  transitionIn: Transition;
  transitionOut: Transition;
  objects: SceneObject[];
  bubbles: Bubble[];
}

/** Title bars share the image editor's strip settings; stored values may be partial. */
export type MovieBand = Partial<Band>;

export const movieBand = (stored: MovieBand | undefined): Band =>
  createBand({ size: 90, fontSize: 38, ...stored });

export const createScene = (duration = 4, transition: Transition = 'fade'): Scene => ({
  id: uid(),
  duration,
  transitionIn: transition,
  transitionOut: 'none',
  objects: [],
  bubbles: [],
});

export const createObject = (
  kind: SceneObject['kind'],
  mediaId: string,
  duration: number,
  patch: Partial<SceneObject> = {},
): SceneObject => ({
  id: uid(),
  kind,
  mediaId,
  x: 0.5,
  y: 0.5,
  width: 0.6,
  fit: 'free',
  trimStart: 0,
  muted: false,
  animation: 'none',
  intensity: 40,
  startSec: 0,
  endSec: duration,
  ...patch,
});

export const createBubble = (duration: number, patch: Partial<Bubble> = {}): Bubble => ({
  id: uid(),
  text: 'Hello!',
  startSec: 0,
  endSec: duration,
  objectId: null,
  x: 0.5,
  y: 0.8,
  bubbleColor: '#ffffff',
  textColor: '#111827',
  fontSize: 40,
  fontFamily: 'system-ui, sans-serif',
  tail: true,
  ...patch,
});

export const movieLength = (scenes: Scene[]): number =>
  scenes.reduce((sum, s) => sum + s.duration, 0);
export const sceneOffset = (scenes: Scene[], index: number): number =>
  movieLength(scenes.slice(0, index));

export function sceneAt(scenes: Scene[], time: number): { index: number; local: number } | null {
  if (!scenes.length) return null;
  let offset = 0;
  for (const [index, scene] of scenes.entries()) {
    if (time < offset + scene.duration - 1e-6) return { index, local: Math.max(0, time - offset) };
    offset += scene.duration;
  }
  const last = scenes.length - 1;
  return { index: last, local: scenes[last]!.duration };
}

/** Changing a scene's length keeps timings inside it, and stretches ones that ran to the end. */
export function setDuration(scene: Scene, duration: number): Scene {
  const length = clamp(duration, 0.5, 600);
  const fix = <T extends { startSec: number; endSec: number }>(item: T): T => {
    const endSec = item.endSec >= scene.duration - 0.001 ? length : Math.min(item.endSec, length);
    return { ...item, startSec: Math.min(item.startSec, Math.max(0, endSec - 0.1)), endSec };
  };
  return {
    ...scene,
    duration: length,
    objects: scene.objects.map(fix),
    bubbles: scene.bubbles.map(fix),
  };
}

/** How the whole scene is offset, scaled and faded by its entrance or exit at `local` seconds. */
export function transitionState(
  scene: Scene,
  local: number,
): { alpha: number; dx: number; dy: number; scale: number } {
  const state = { alpha: 1, dx: 0, dy: 0, scale: 1 };
  const window = Math.min(TRANSITION_SECONDS, scene.duration / 2);
  const apply = (type: Transition, hidden: number, leaving: boolean) => {
    if (hidden <= 0) return;
    const sign = leaving ? -1 : 1;
    if (type === 'fade') state.alpha = 1 - hidden;
    if (type === 'zoom') {
      state.alpha = 1 - hidden;
      state.scale = 1 - 0.35 * hidden;
    }
    // "slide-left" means the movement is towards the left, both entering and leaving.
    if (type === 'slide-left') state.dx = sign * hidden;
    if (type === 'slide-right') state.dx = -sign * hidden;
    if (type === 'slide-up') state.dy = sign * hidden;
    if (type === 'slide-down') state.dy = -sign * hidden;
  };
  if (local < window) apply(scene.transitionIn, 1 - local / window, false);
  else if (local > scene.duration - window)
    apply(scene.transitionOut, (local - (scene.duration - window)) / window, true);
  return state;
}

export function animationState(
  object: SceneObject,
  local: number,
): { scale: number; dx: number; dy: number; angle: number; skew: number } {
  const strength = object.intensity / 100;
  const length = Math.max(0.1, object.endSec - object.startSec);
  const progress = clamp((local - object.startSec) / length, 0, 1);
  const state = { scale: 1, dx: 0, dy: 0, angle: 0, skew: 0 };
  if (object.animation === 'kenburns-in') state.scale = 1 + 0.4 * strength * progress;
  if (object.animation === 'kenburns-out') state.scale = 1 + 0.4 * strength * (1 - progress);
  if (object.animation === 'shake') {
    state.dx = Math.sin(local * 47) * 14 * strength;
    state.dy = Math.cos(local * 39) * 10 * strength;
  }
  if (object.animation === 'tilt3d') {
    state.angle = Math.sin(local * 2) * 0.08 * strength;
    state.skew = Math.cos(local * 2) * 0.12 * strength;
  }
  return state;
}

export interface SlideSource {
  id: string;
  kind: 'video' | 'image';
  duration?: number;
}

/** One full-frame scene per picture or video. */
export function buildSlideshow(
  sources: SlideSource[],
  seconds: number,
  transition: Transition,
): Scene[] {
  return sources.map((source) => {
    const length =
      source.kind === 'video' && source.duration ? clamp(source.duration, 0.5, 600) : seconds;
    const scene = createScene(length, transition);
    scene.objects = [
      createObject(source.kind, source.id, length, {
        fit: 'contain',
        animation: source.kind === 'image' ? 'kenburns-in' : 'none',
        intensity: 25,
      }),
    ];
    return scene;
  });
}
