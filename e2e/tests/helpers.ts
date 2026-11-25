import { test as base, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(decodeURIComponent(here), '../..');
export const fromServer = createRequire(path.join(root, 'server', 'package.json'));
export const fromClient = createRequire(path.join(root, 'client', 'package.json'));

export const fixtures = path.join(tmpdir(), 'studio-e2e-fixtures');
export const file = (name: string) => path.join(fixtures, name);

export async function makeFixtures(): Promise<void> {
  mkdirSync(fixtures, { recursive: true });
  const ffmpeg = fromServer('ffmpeg-static') as string;
  const run = (...args: string[]) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  run(
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=1:duration=1',
    '-frames:v',
    '1',
    file('photo.png'),
  );
  run(
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=25:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=4',
    '-c:v',
    'libvpx',
    '-b:v',
    '500k',
    '-c:a',
    'libopus',
    '-shortest',
    file('clip.webm'),
  );
  const { PDFDocument, StandardFonts } = fromClient('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['Quarterly report summary', 'Second page appendix']) {
    pdf.addPage([500, 700]).drawText(text, { x: 60, y: 600, size: 28, font });
  }
  writeFileSync(file('report.pdf'), await pdf.save());
}

/** Fails a test on any uncaught error or console error. */
export function watchErrors(page: Page, errors: string[]): void {
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(`console: ${message.text()} ${message.location().url}`);
  });
}

export async function register(page: Page, username: string, name: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Create a new account' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.waitForURL('**/workspaces');
  await page.getByLabel('Customer name').fill(`${name} workspace`);
  await page.getByRole('button', { name: 'Create customer' }).click();
  await page.waitForURL('**/files');
}

export async function newUser(browser: Browser, username: string, name: string, errors: string[]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  watchErrors(page, errors);
  await register(page, username, name);
  return { context, page };
}

export async function upload(
  page: Page,
  trigger: () => Promise<unknown>,
  ...names: string[]
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await trigger();
  await (await chooser).setFiles(names.map(file));
}

/** Answers the app's text prompt dialog. */
export async function answer(page: Page, value: string): Promise<void> {
  const dialog = page.getByRole('dialog').last();
  await dialog.locator('input[name="value"]').fill(value);
  await dialog.locator('button[type="submit"]').click();
}

export const saved = (page: Page) => expect(page.getByText('All changes saved')).toBeVisible();

export const downloadBytes = async (page: Page, trigger: () => Promise<unknown>) => {
  const wait = page.waitForEvent('download');
  await trigger();
  const download = await wait;
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
};

/**
 * A real Chrome drag, driven through the DevTools protocol. Playwright's own dragTo needs to run a script
 * in the frame where the drag starts, which the website canvas (sandboxed, no scripts) does not allow.
 * Returns the data types the page put on the drag, so a missing dragstart handler is detected.
 */
export async function nativeDrag(page: Page, from: Locator, to: Locator): Promise<string[]> {
  const centre = async (target: Locator) => {
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  return nativeDragPoints(page, await centre(from), await centre(to));
}

export async function nativeDragPoints(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.setInterceptDrags', { enabled: true });
    const intercepted = new Promise<any>((resolve, reject) => {
      cdp.once('Input.dragIntercepted', (event) => resolve(event.data));
      setTimeout(() => reject(new Error('Chrome did not start a drag')), 8000);
    });
    const mouse = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', x: number, y: number) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
      });
    await mouse('mousePressed', start.x, start.y);
    // The move that crosses the drag threshold does not resolve until the drag is handled.
    const moving = mouse('mouseMoved', start.x + 12, start.y + 12);
    const data = await intercepted;
    await moving;
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x: end.x, y: end.y, data });
    }
    await mouse('mouseReleased', end.x, end.y);
    return (data.items as { mimeType: string }[]).map((item) => item.mimeType);
  } finally {
    await cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
    await cdp.detach();
  }
}

export const test = base;
export { expect };

/** Recreates the library state that the files test leaves behind. */
export async function seedLibrary(page: Page): Promise<void> {
  const headers = { 'X-Requested-With': 'studio' };
  const folder = await (
    await page.request.post('/api/docs/folders', { headers, data: { name: 'Holiday' } })
  ).json();
  for (const [name, mimeType] of [
    ['photo.png', 'image/png'],
    ['clip.webm', 'video/webm'],
    ['report.pdf', 'application/pdf'],
  ] as const) {
    await page.request.post('/api/media', {
      headers,
      multipart: {
        file: { name, mimeType, buffer: readFileSync(file(name)) },
        ...(name === 'photo.png' ? { folderId: folder.id as string } : {}),
      },
    });
  }
}
