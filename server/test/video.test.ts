import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { formWith, PNG, signUpWithWorkspace, startServer } from './helpers.ts';
import { parseProbe, probeFile } from '../src/video.ts';
import { videoSpecSchema } from '../src/video-args.ts';

let server: Awaited<ReturnType<typeof startServer>>;
let user: Awaited<ReturnType<typeof signUpWithWorkspace>>;
let withAudio = '';
let silent = '';
let picture = '';
let music = '';

const ffmpeg = (...args: string[]) =>
  execFileSync(ffmpegPath as unknown as string, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...args,
  ]);

async function upload(name: string, type: string): Promise<string> {
  const bytes = await readFile(path.join(server.dataDir, name));
  const result = await user.agent.post('/api/media', formWith('file', bytes, name, type));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.id;
}

before(async () => {
  server = await startServer();
  user = await signUpWithWorkspace(server.base, 'editor');
  const at = (name: string) => path.join(server.dataDir, name);
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=25:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    at('a.mp4'),
  );
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=240x320:rate=30:duration=2',
    '-c:v',
    'libvpx-vp9',
    at('b.webm'),
  );
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=800:duration=1', at('m.mp3'));
  ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=c=blue@0.4:size=640x360,format=rgba',
    '-frames:v',
    '1',
    at('overlay.png'),
  );
  await writeFile(at('p.png'), PNG);
  withAudio = await upload('a.mp4', 'video/mp4');
  silent = await upload('b.webm', 'video/webm');
  picture = await upload('p.png', 'image/png');
  music = await upload('m.mp3', 'audio/mpeg');
});
after(() => server.stop());

async function exportVideo(spec: object, overlays = 0) {
  const form = new FormData();
  form.append('spec', JSON.stringify(spec));
  const png = await readFile(path.join(server.dataDir, 'overlay.png'));
  for (let i = 0; i < overlays; i++)
    form.append('overlays', new Blob([png], { type: 'image/png' }), `o${i}.png`);
  const created = await user.agent.post('/api/video/jobs', form);
  assert.equal(created.status, 202, JSON.stringify(created.data));
  for (;;) {
    const job = (await user.agent.get(`/api/video/jobs/${created.data.id}`)).data;
    if (job.status === 'done') return job.mediaId as string;
    assert.ok(job.status === 'queued' || job.status === 'running', job.error ?? job.status);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function probeMedia(id: string) {
  return (await user.agent.get(`/api/video/probe/${id}`)).data;
}

test('parses probe output including rotated phone video', () => {
  const output = `  Duration: 00:01:02.50, start: 0\n  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080 [SAR 1:1], 30 fps\n    displaymatrix: rotation of -90.00 degrees\n  Stream #0:1: Audio: aac`;
  assert.deepEqual(parseProbe(output), {
    duration: 62.5,
    width: 1080,
    height: 1920,
    hasVideo: true,
    hasAudio: true,
  });
});

test('probe reads a real file', async () => {
  const probe = await probeMedia(withAudio);
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 240);
  assert.equal(probe.hasAudio, true);
  assert.ok(Math.abs(probe.duration - 3) < 0.2);
});

test('rejects invalid specifications', () => {
  const bad = (clip: object) =>
    videoSpecSchema.safeParse({ clips: [{ mediaId: 'x', end: 1, ...clip }] }).success;
  assert.equal(bad({ start: 2 }), false);
  assert.equal(bad({ crop: { x: 0.8, y: 0, w: 0.5, h: 1 } }), false);
  assert.equal(bad({ speed: 100 }), false);
  assert.equal(videoSpecSchema.safeParse({ clips: [] }).success, false);
});

test('merges every effect into one mp4 with the expected length', async () => {
  const id = await exportVideo(
    {
      title: 'Combined',
      width: 640,
      height: 360,
      fadeIn: 0.3,
      fadeOut: 0.3,
      music: { mediaId: music, volume: 0.4 },
      overlays: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      clips: [
        {
          mediaId: withAudio,
          start: 0.5,
          end: 2.5,
          speed: 2,
          rotate: 90,
          flipH: true,
          brightness: 0.1,
          contrast: 1.2,
          saturation: 1.4,
          crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        },
        {
          mediaId: silent,
          start: 0,
          end: 1,
          speed: 0.25,
          grayscale: true,
          blur: 2,
          flipV: true,
          rotate: 270,
        },
        { mediaId: picture, start: 0, end: 1.5, rotate: 180 },
      ],
    },
    2,
  );
  const probe = await probeMedia(id);
  assert.equal(probe.width, 640);
  assert.equal(probe.height, 360);
  assert.equal(probe.hasAudio, true);
  assert.ok(Math.abs(probe.duration - 6.5) < 0.25, `duration ${probe.duration}`);
});

for (const format of ['webm', 'gif', 'mp3'] as const) {
  test(`exports ${format}`, async () => {
    const id = await exportVideo({
      format,
      width: 160,
      height: 120,
      fps: 10,
      clips: [{ mediaId: withAudio, end: 1 }],
    });
    const media = (await user.agent.get('/api/media')).data.find((m: any) => m.id === id);
    assert.ok(media.size > 100);
    assert.equal(media.kind, { webm: 'video', gif: 'image', mp3: 'audio' }[format]);
  });
}

test('measures recordings that have no duration header', async () => {
  const source = path.join(server.dataDir, 'noheader.webm');
  const stream = ffmpeg(
    '-f',
    'lavfi',
    '-i',
    'color=size=64x64:rate=10:duration=2',
    '-c:v',
    'libvpx',
    '-f',
    'webm',
    'pipe:1',
  );
  await writeFile(source, stream);
  const probe = await probeFile(source);
  assert.ok(Math.abs(probe.duration - 2) < 0.3, `duration ${probe.duration}`);
});
