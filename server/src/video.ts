import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rename } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import ffmpegPath from 'ffmpeg-static';
import type { Db } from './db.ts';
import { findDoc } from './docs.ts';
import { sniff, type FileStore } from './files.ts';
import { HttpError, notFound, param, parse, workspaceOf } from './http.ts';
import { fileSize, findMedia, insertMedia } from './media.ts';
import {
  buildFfmpegArgs,
  totalDuration,
  videoSpecSchema,
  type BuildInput,
  type ClipInput,
  type VideoSpec,
} from './video-args.ts';

const FFMPEG = process.env['FFMPEG_PATH'] || (ffmpegPath as unknown as string);
const MAX_RUNNING = 2;
const MAX_QUEUED_PER_WORKSPACE = 5;
const JOB_TIMEOUT_MS = 30 * 60_000;

export interface Probe {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

function run(args: string[], onStdout?: (text: string) => void) {
  const child = spawn(FFMPEG, args, { windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-60_000)));
  child.stdout.on('data', (chunk) => onStdout?.(String(chunk)));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  return { child, done };
}

const seconds = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);

export function parseProbe(output: string): Probe {
  const header = /Duration: (\d+):(\d+):([\d.]+)/.exec(output);
  const video = output
    .split('\n')
    .find((line) => /Stream #.*Video:/.test(line) && !line.includes('attached pic'));
  const size = video && /, (\d{2,5})x(\d{2,5})[\s,[]/.exec(`${video} `);
  let width = size ? Number(size[1]) : 0;
  let height = size ? Number(size[2]) : 0;
  // Phone footage stores a rotation flag; FFmpeg applies it, so report the displayed orientation.
  if (/rotat(?:e\s*:\s*|ion of )-?(90|270)/.test(output)) [width, height] = [height, width];
  return {
    duration: header ? seconds(header[1]!, header[2]!, header[3]!) : 0,
    width,
    height,
    hasVideo: Boolean(video),
    hasAudio: /Stream #.*Audio:/.test(output),
  };
}

export async function probeFile(fullPath: string): Promise<Probe> {
  const { stderr } = await run(['-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', fullPath])
    .done;
  const probe = parseProbe(stderr);
  if (probe.duration > 0 || (!probe.hasVideo && !probe.hasAudio)) return probe;
  // Browser recordings often omit the duration header; decode once to measure them.
  const decoded = await run([
    '-hide_banner',
    '-nostdin',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    fullPath,
    '-f',
    'null',
    '-',
  ]).done;
  const times = [...decoded.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = times.at(-1);
  return { ...probe, duration: last ? seconds(last[1]!, last[2]!, last[3]!) : 0 };
}

interface Job {
  id: string;
  workspaceId: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  error: string | null;
  mediaId: string | null;
  finishedAt: number;
}

interface Task {
  job: Job;
  spec: VideoSpec;
  build: BuildInput;
  child: ChildProcess | null;
}

export class VideoQueue {
  private readonly tasks = new Map<string, Task>();
  private readonly waiting: Task[] = [];
  private running = 0;
  private closed = false;
  private readonly db: Db;
  private readonly files: FileStore;

  constructor(db: Db, files: FileStore) {
    this.db = db;
    this.files = files;
  }

  add(workspaceId: string, spec: VideoSpec, build: BuildInput): Job {
    const cutoff = Date.now() - 3_600_000;
    for (const [id, task] of this.tasks) {
      if (task.job.finishedAt && task.job.finishedAt < cutoff) this.tasks.delete(id);
    }
    const active = [...this.tasks.values()].filter(
      (t) => t.job.workspaceId === workspaceId && !t.job.finishedAt,
    ).length;
    if (active >= MAX_QUEUED_PER_WORKSPACE)
      throw new HttpError(429, 'Wait for your other exports to finish');
    const job: Job = {
      id: randomUUID(),
      workspaceId,
      status: 'queued',
      progress: 0,
      error: null,
      mediaId: null,
      finishedAt: 0,
    };
    const task: Task = { job, spec, build, child: null };
    this.tasks.set(job.id, task);
    this.waiting.push(task);
    this.pump();
    return job;
  }

  find(workspaceId: string, id: string): Task {
    const task = this.tasks.get(id);
    if (!task || task.job.workspaceId !== workspaceId) throw notFound('Export job');
    return task;
  }

  cancel(task: Task): void {
    if (task.job.finishedAt) return;
    const queuedAt = this.waiting.indexOf(task);
    if (queuedAt >= 0) {
      this.waiting.splice(queuedAt, 1);
      void this.cleanup(task);
    }
    task.job.status = 'cancelled';
    task.job.finishedAt = Date.now();
    task.child?.kill('SIGKILL');
  }

  close(): void {
    this.closed = true;
    for (const task of this.tasks.values()) this.cancel(task);
  }

  private pump(): void {
    while (!this.closed && this.running < MAX_RUNNING && this.waiting.length) {
      const task = this.waiting.shift()!;
      this.running++;
      void this.execute(task).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async cleanup(task: Task): Promise<void> {
    await Promise.all(
      [...task.build.overlayPaths, task.build.outputPath].map((p) => this.files.discard(p)),
    );
  }

  private async execute(task: Task): Promise<void> {
    const { job, spec, build } = task;
    job.status = 'running';
    let timer: NodeJS.Timeout | undefined;
    try {
      const total = totalDuration(spec);
      const encoder = run(buildFfmpegArgs(build), (output) => {
        const match = [...output.matchAll(/out_time_us=(\d+)/g)].at(-1);
        if (match) job.progress = Math.min(0.99, Number(match[1]) / 1_000_000 / total);
      });
      task.child = encoder.child;
      timer = setTimeout(() => encoder.child.kill('SIGKILL'), JOB_TIMEOUT_MS);
      const result = await encoder.done;
      if ((job.status as Job['status']) === 'cancelled') return;
      if (result.code !== 0) {
        console.error(`FFmpeg failed (${result.code}):\n${result.stderr}`);
        throw new Error(
          'FFmpeg could not process this video. Check that every clip plays correctly.',
        );
      }
      const size = await fileSize(build.outputPath);
      const filename = `${randomUUID()}.${spec.format}`;
      await rename(build.outputPath, this.files.pathOf(filename));
      const mime = { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', mp3: 'audio/mpeg' }[
        spec.format
      ];
      const kind = spec.format === 'gif' ? 'image' : spec.format === 'mp3' ? 'audio' : 'video';
      try {
        const folderId =
          spec.folderId && findDoc(this.db, job.workspaceId, 'folders', spec.folderId)
            ? spec.folderId
            : null;
        job.mediaId = insertMedia(
          this.db,
          job.workspaceId,
          { kind, mime, filename, size },
          spec.title,
          folderId,
        ).id;
      } catch (error) {
        await this.files.remove([filename]);
        throw error;
      }
      job.progress = 1;
      job.status = 'done';
    } catch (error) {
      if ((job.status as Job['status']) !== 'cancelled') {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : 'Export failed';
      }
    } finally {
      if (timer) clearTimeout(timer);
      task.child = null;
      job.finishedAt ||= Date.now();
      await this.cleanup(task);
    }
  }
}

export function videoRoutes(db: Db, files: FileStore, queue: VideoQueue): Router {
  const router = Router();
  const view = ({ finishedAt: _finishedAt, workspaceId: _workspaceId, ...job }: Job) => job;
  const media = (workspaceId: string, id: string) => {
    const record = findMedia(db, workspaceId, id);
    if (!record) throw notFound('Source file');
    return record;
  };

  router.get('/probe/:mediaId', async (req, res) => {
    const record = media(workspaceOf(req), param(req, 'mediaId'));
    res.json(await probeFile(files.pathOf(record.filename)));
  });

  router.post('/jobs', files.upload.array('overlays', 40), async (req, res) => {
    const uploads = (req.files as Express.Multer.File[] | undefined) ?? [];
    let accepted = false;
    try {
      const workspaceId = workspaceOf(req);
      let raw: unknown;
      try {
        raw = JSON.parse(String((req.body as { spec?: string })?.spec ?? ''));
      } catch {
        throw new HttpError(400, 'Missing export settings');
      }
      const spec = parse(videoSpecSchema, raw);
      if (spec.overlays.length !== uploads.length)
        throw new HttpError(400, 'Overlay timing does not match the images');
      for (const upload of uploads) {
        const handle = await open(upload.path, 'r');
        const head = Buffer.alloc(16);
        await handle.read(head, 0, 16, 0).finally(() => handle.close());
        if (sniff(head).mime !== 'image/png')
          throw new HttpError(415, 'Overlays must be PNG images');
      }
      const clips: ClipInput[] = [];
      for (const clip of spec.clips) {
        const record = media(workspaceId, clip.mediaId);
        if (record.kind !== 'video' && record.kind !== 'image') {
          throw new HttpError(400, `"${record.title}" is not a video or picture`);
        }
        const fullPath = files.pathOf(record.filename);
        const hasAudio = record.kind === 'video' && (await probeFile(fullPath)).hasAudio;
        clips.push({ path: fullPath, kind: record.kind, mime: record.mime, hasAudio });
      }
      let musicPath: string | null = null;
      if (spec.music) {
        musicPath = files.pathOf(media(workspaceId, spec.music.mediaId).filename);
        if (!(await probeFile(musicPath)).hasAudio)
          throw new HttpError(400, 'The music file has no audio');
      }
      if (
        spec.format === 'mp3' &&
        !musicPath &&
        !spec.clips.some((c, i) => clips[i]!.hasAudio && !c.muted)
      ) {
        throw new HttpError(400, 'There is no audio to export');
      }
      const job = queue.add(workspaceId, spec, {
        spec,
        clips,
        overlayPaths: uploads.map((u) => u.path),
        musicPath,
        outputPath: path.join(files.tmpDir, `${randomUUID()}.${spec.format}`),
      });
      accepted = true;
      res.status(202).json(view(job));
    } finally {
      if (!accepted) await Promise.all(uploads.map((u) => files.discard(u.path)));
    }
  });

  router.get('/jobs/:id', (req, res) => {
    res.json(view(queue.find(workspaceOf(req), param(req, 'id')).job));
  });

  router.delete('/jobs/:id', (req, res) => {
    queue.cancel(queue.find(workspaceOf(req), param(req, 'id')));
    res.status(204).end();
  });

  return router;
}
