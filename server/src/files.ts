import { mkdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import type { Response } from 'express';
import type { Config } from './config.ts';
import { HttpError, notFound } from './http.ts';

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'other';

export interface Sniffed {
  kind: FileKind;
  mime: string;
  ext: string;
}

const make = (kind: FileKind, mime: string, ext: string): Sniffed => ({ kind, mime, ext });

/** Identifies a file by its leading bytes, so a renamed or mislabelled upload cannot spoof its type. */
export function sniff(head: Buffer, declaredMime = ''): Sniffed {
  const ascii = (from: number, to: number) => head.subarray(from, to).toString('latin1');
  const hex = head.subarray(0, 4).toString('hex');
  const audio = declaredMime.startsWith('audio/');

  if (hex === '89504e47') return make('image', 'image/png', 'png');
  if (hex.startsWith('ffd8ff')) return make('image', 'image/jpeg', 'jpg');
  if (ascii(0, 4) === 'GIF8') return make('image', 'image/gif', 'gif');
  if (ascii(0, 2) === 'BM' && declaredMime === 'image/bmp')
    return make('image', 'image/bmp', 'bmp');
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 12);
    if (form === 'WEBP') return make('image', 'image/webp', 'webp');
    if (form === 'WAVE') return make('audio', 'audio/wav', 'wav');
    if (form === 'AVI ') return make('video', 'video/x-msvideo', 'avi');
  }
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return make('image', 'image/avif', 'avif');
    if (brand === 'M4A ' || audio) return make('audio', 'audio/mp4', 'm4a');
    if (brand === 'qt  ') return make('video', 'video/quicktime', 'mov');
    return make('video', 'video/mp4', 'mp4');
  }
  if (hex === '1a45dfa3') {
    return audio ? make('audio', 'audio/webm', 'weba') : make('video', 'video/webm', 'webm');
  }
  if (ascii(0, 4) === 'OggS') return make('audio', 'audio/ogg', 'ogg');
  if (ascii(0, 3) === 'ID3' || hex.startsWith('fffb') || hex.startsWith('fff3')) {
    return make('audio', 'audio/mpeg', 'mp3');
  }
  if (ascii(0, 5) === '%PDF-') return make('pdf', 'application/pdf', 'pdf');
  return make('other', 'application/octet-stream', 'bin');
}

export interface StoredFile extends Sniffed {
  filename: string;
  size: number;
}

export class FileStore {
  readonly dir: string;
  readonly tmpDir: string;
  readonly upload: multer.Multer;

  constructor(config: Config) {
    this.dir = path.join(config.dataDir, 'files');
    this.tmpDir = path.join(config.dataDir, 'tmp');
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    this.upload = multer({
      dest: this.tmpDir,
      limits: { fileSize: config.maxUploadBytes, fields: 20, fieldSize: 2 * 1024 * 1024 },
      // Without this multer decodes non-ASCII filenames as latin1.
      defParamCharset: 'utf8',
    });
  }

  pathOf(filename: string): string {
    return path.join(this.dir, path.basename(filename));
  }

  /** Moves a multer temp file into permanent storage under a random name. */
  async adopt(file: Express.Multer.File, allowOther: boolean): Promise<StoredFile> {
    const handle = await open(file.path, 'r');
    const head = Buffer.alloc(16);
    try {
      await handle.read(head, 0, 16, 0);
    } finally {
      await handle.close();
    }
    const type = sniff(head, file.mimetype);
    if (file.size === 0 || (type.kind === 'other' && !allowOther)) {
      await this.discard(file.path);
      throw new HttpError(415, file.size === 0 ? 'The file is empty' : 'Unsupported file type');
    }
    const filename = `${randomUUID()}.${type.ext}`;
    await rename(file.path, this.pathOf(filename));
    return { ...type, filename, size: file.size };
  }

  /** For cover pictures: images only, at most 5 MB. */
  async adoptImage(file: Express.Multer.File): Promise<StoredFile> {
    if (file.size > 5 * 1024 * 1024) {
      await this.discard(file.path);
      throw new HttpError(413, 'Choose a picture smaller than 5 MB');
    }
    const stored = await this.adopt(file, false);
    if (stored.kind !== 'image') {
      await this.remove([stored.filename]);
      throw new HttpError(415, 'Choose a picture file');
    }
    return stored;
  }

  async discard(fullPath: string): Promise<void> {
    await rm(fullPath, { force: true }).catch(() => undefined);
  }

  /** Best-effort delete: a file still being streamed on Windows must not fail the request. */
  async remove(filenames: string[]): Promise<void> {
    await Promise.all(filenames.map((name) => this.discard(this.pathOf(name))));
  }

  /** Streams a stored file with headers that stop uploaded content running as a page on our origin. */
  send(
    res: Response,
    filename: string,
    mime: string,
    downloadName: string,
    forceDownload = false,
  ): void {
    const attachment = forceDownload || mime === 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; media-src 'self'; img-src 'self'",
    );
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader(
      'Content-Disposition',
      `${attachment ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    );
    res.sendFile(this.pathOf(filename), { dotfiles: 'allow', cacheControl: false }, (error) => {
      if (error && !res.headersSent)
        res.status(notFound().status).json({ error: 'File not found' });
    });
  }
}
