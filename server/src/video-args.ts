/** Pure translation of an edit specification into FFmpeg arguments. Every value is validated and numeric. */
import { z } from 'zod';

const fraction = z.number().min(0).max(1);
const MIN_CLIP_SECONDS = 0.1;

export const clipSchema = z
  .object({
    mediaId: z.string().max(64),
    start: z.number().min(0).max(86_400).default(0),
    end: z.number().min(0).max(86_400),
    speed: z.number().min(0.25).max(4).default(1),
    volume: z.number().min(0).max(2).default(1),
    muted: z.boolean().default(false),
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
    crop: z
      .object({
        x: fraction,
        y: fraction,
        w: z.number().min(0.05).max(1),
        h: z.number().min(0.05).max(1),
      })
      .refine((c) => c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001, 'Crop must stay inside the frame')
      .nullable()
      .default(null),
    brightness: z.number().min(-0.5).max(0.5).default(0),
    contrast: z.number().min(0).max(2).default(1),
    saturation: z.number().min(0).max(3).default(1),
    grayscale: z.boolean().default(false),
    blur: z.number().min(0).max(20).default(0),
    hue: z.number().min(-180).max(180).default(0),
    sepia: fraction.default(0),
    invert: z.boolean().default(false),
    /** Size of each block in output pixels; 0 switches it off. */
    pixelate: z.number().int().min(0).max(60).default(0),
    vignette: fraction.default(0),
  })
  .refine(
    (c) => c.end - c.start >= MIN_CLIP_SECONDS,
    'Each clip must be at least 0.1 seconds long',
  );

export const videoSpecSchema = z.object({
  title: z.string().trim().min(1).max(200).default('Edited video'),
  folderId: z.string().max(64).nullable().default(null),
  clips: z.array(clipSchema).min(1, 'Add at least one clip').max(50),
  width: z.number().int().min(64).max(3840).default(1280),
  height: z.number().int().min(64).max(3840).default(720),
  fps: z.number().int().min(5).max(60).default(30),
  format: z.enum(['mp4', 'webm', 'gif', 'mp3']).default('mp4'),
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  fadeIn: z.number().min(0).max(10).default(0),
  fadeOut: z.number().min(0).max(10).default(0),
  music: z
    .object({ mediaId: z.string().max(64), volume: z.number().min(0).max(2).default(0.5) })
    .nullable()
    .default(null),
  /** One entry per uploaded overlay PNG, in upload order. */
  overlays: z
    .array(z.object({ start: z.number().min(0), end: z.number().min(0) }))
    .max(40)
    .default([]),
});

export type VideoSpec = z.output<typeof videoSpecSchema>;
export type ClipSpec = VideoSpec['clips'][number];

export interface ClipInput {
  path: string;
  kind: 'video' | 'image';
  mime: string;
  hasAudio: boolean;
}

export const clipDuration = (clip: ClipSpec) => (clip.end - clip.start) / clip.speed;
export const totalDuration = (spec: VideoSpec) =>
  spec.clips.reduce((sum, c) => sum + clipDuration(c), 0);

const n = (value: number) => Number(value.toFixed(4)).toString();
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** `atempo` only accepts 0.5-100 per instance, so slower speeds are chained. */
function tempo(speed: number): string[] {
  const parts: string[] = [];
  let rest = speed;
  while (rest < 0.5) {
    parts.push('atempo=0.5');
    rest /= 0.5;
  }
  if (Math.abs(rest - 1) > 0.001) parts.push(`atempo=${n(rest)}`);
  return parts;
}

function videoChain(clip: ClipSpec, width: number, height: number, fps: number): string {
  const duration = n(clipDuration(clip));
  const chain: string[] = [`setpts=(PTS-STARTPTS)/${n(clip.speed)}`];
  if (clip.crop) {
    const c = clip.crop;
    chain.push(`crop=iw*${n(c.w)}:ih*${n(c.h)}:iw*${n(c.x)}:ih*${n(c.y)}`);
  }
  if (clip.rotate === 90) chain.push('transpose=1');
  if (clip.rotate === 180) chain.push('hflip', 'vflip');
  if (clip.rotate === 270) chain.push('transpose=2');
  if (clip.flipH) chain.push('hflip');
  if (clip.flipV) chain.push('vflip');
  if (clip.brightness !== 0 || clip.contrast !== 1 || clip.saturation !== 1) {
    chain.push(
      `eq=brightness=${n(clip.brightness)}:contrast=${n(clip.contrast)}:saturation=${n(clip.saturation)}`,
    );
  }
  if (clip.hue !== 0) chain.push(`hue=h=${n(clip.hue)}`);
  if (clip.grayscale) chain.push('hue=s=0');
  if (clip.sepia > 0) {
    // Blend the standard sepia matrix with the identity matrix by the chosen amount.
    const a = clip.sepia;
    const mix = (identity: number, full: number) => n(identity + (full - identity) * a);
    chain.push(
      `colorchannelmixer=rr=${mix(1, 0.393)}:rg=${mix(0, 0.769)}:rb=${mix(0, 0.189)}` +
        `:gr=${mix(0, 0.349)}:gg=${mix(1, 0.686)}:gb=${mix(0, 0.168)}` +
        `:br=${mix(0, 0.272)}:bg=${mix(0, 0.534)}:bb=${mix(1, 0.131)}`,
    );
  }
  // Negating in RGB matches the browser preview; negating YUV planes would not.
  if (clip.invert) chain.push('format=gbrp', 'negate');
  if (clip.blur > 0) chain.push(`gblur=sigma=${n(clip.blur)}`);
  chain.push(
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
    ...(clip.pixelate > 1
      ? [
          `scale=${Math.max(2, Math.round(width / clip.pixelate))}:${Math.max(2, Math.round(height / clip.pixelate))}:flags=neighbor`,
          `scale=${width}:${height}:flags=neighbor`,
        ]
      : []),
    ...(clip.vignette > 0 ? [`vignette=angle=${n(clip.vignette * 1.2)}`] : []),
    'setsar=1',
    `fps=${fps}`,
    // Hold the last frame if the source is shorter than requested, then cut to the exact length.
    `tpad=stop_mode=clone:stop_duration=${duration}`,
    `trim=duration=${duration}`,
    'setpts=PTS-STARTPTS',
    'format=yuv420p',
  );
  return chain.join(',');
}

function audioChain(clip: ClipSpec): string {
  const duration = n(clipDuration(clip));
  return [
    'asetpts=PTS-STARTPTS',
    ...tempo(clip.speed),
    `volume=${n(clip.volume)}`,
    'aresample=44100',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    'apad',
    `atrim=duration=${duration}`,
    'asetpts=PTS-STARTPTS',
  ].join(',');
}

export interface BuildInput {
  spec: VideoSpec;
  clips: ClipInput[];
  overlayPaths: string[];
  musicPath: string | null;
  outputPath: string;
}

export function buildFfmpegArgs({
  spec,
  clips,
  overlayPaths,
  musicPath,
  outputPath,
}: BuildInput): string[] {
  const wantsVideo = spec.format !== 'mp3';
  const wantsAudio = spec.format !== 'gif';
  const width = even(spec.width);
  const height = even(spec.height);
  const total = totalDuration(spec);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
  ];
  const input = (path: string, options: string[] = []) =>
    args.push('-protocol_whitelist', 'file,pipe', ...options, '-i', path);

  spec.clips.forEach((clip, i) => {
    const source = clips[i]!;
    const length = n(clip.end - clip.start);
    if (source.kind === 'image') {
      const loop = source.mime === 'image/gif' ? ['-ignore_loop', '0'] : ['-loop', '1'];
      input(source.path, [...loop, '-t', length]);
    } else {
      input(source.path, ['-ss', n(clip.start), '-t', length]);
    }
  });

  const filters: string[] = [];
  let concatInputs = '';
  spec.clips.forEach((clip, i) => {
    if (wantsVideo) {
      filters.push(`[${i}:v:0]${videoChain(clip, width, height, spec.fps)}[v${i}]`);
      concatInputs += `[v${i}]`;
    }
    if (wantsAudio) {
      if (clips[i]!.hasAudio && !clip.muted) {
        filters.push(`[${i}:a:0]${audioChain(clip)}[a${i}]`);
      } else {
        filters.push(
          `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${n(clipDuration(clip))},aformat=sample_fmts=fltp[a${i}]`,
        );
      }
      concatInputs += `[a${i}]`;
    }
  });
  filters.push(
    `${concatInputs}concat=n=${spec.clips.length}:v=${wantsVideo ? 1 : 0}:a=${wantsAudio ? 1 : 0}` +
      `${wantsVideo ? '[vcat]' : ''}${wantsAudio ? '[acat]' : ''}`,
  );

  let index = spec.clips.length;
  let video = 'vcat';
  let audio = 'acat';

  if (wantsVideo) {
    overlayPaths.forEach((path, i) => {
      const timing = spec.overlays[i]!;
      input(path);
      filters.push(
        `[${video}][${index}:v:0]overlay=0:0:enable='between(t,${n(timing.start)},${n(timing.end)})'[ov${i}]`,
      );
      video = `ov${i}`;
      index++;
    });
  }
  if (wantsAudio && spec.music && musicPath) {
    input(musicPath, ['-stream_loop', '-1']);
    filters.push(
      `[${index}:a:0]volume=${n(spec.music.volume)},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `atrim=duration=${n(total)}[music]`,
      `[${audio}][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97[mixed]`,
    );
    audio = 'mixed';
    index++;
  }

  const fadeIn = Math.min(spec.fadeIn, total);
  const fadeOut = Math.min(spec.fadeOut, total);
  const fades = (prefix: '' | 'a') => {
    const list: string[] = [];
    if (fadeIn > 0) list.push(`${prefix}fade=t=in:st=0:d=${n(fadeIn)}`);
    if (fadeOut > 0) list.push(`${prefix}fade=t=out:st=${n(total - fadeOut)}:d=${n(fadeOut)}`);
    return list;
  };
  if (wantsVideo && fades('').length) {
    filters.push(`[${video}]${fades('').join(',')}[vfade]`);
    video = 'vfade';
  }
  if (wantsAudio && fades('a').length) {
    filters.push(`[${audio}]${fades('a').join(',')}[afade]`);
    audio = 'afade';
  }
  if (spec.format === 'gif') {
    filters.push(
      `[${video}]split[g1][g2]`,
      '[g1]palettegen=stats_mode=diff[pal]',
      '[g2][pal]paletteuse=dither=bayer:bayer_scale=3[gifout]',
    );
    video = 'gifout';
  }

  args.push('-filter_complex', filters.join(';'));
  if (wantsVideo) args.push('-map', `[${video}]`);
  if (wantsAudio) args.push('-map', `[${audio}]`);

  const level = { low: 0, medium: 1, high: 2 }[spec.quality];
  if (spec.format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', ['30', '23', '18'][level]!);
    args.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
  } else if (spec.format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', ['42', '34', '28'][level]!);
    args.push(
      '-deadline',
      'realtime',
      '-cpu-used',
      '6',
      '-row-mt',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '128k',
    );
  } else if (spec.format === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', ['128k', '192k', '320k'][level]!);
  } else {
    args.push('-loop', '0');
  }
  args.push('-t', n(total), outputPath);
  return args;
}
