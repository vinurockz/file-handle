import type { BrowserContext, Page } from '@playwright/test';
import {
  answer,
  downloadBytes,
  expect,
  fromClient,
  makeFixtures,
  newUser,
  saved,
  seedLibrary,
  test,
  upload,
} from './helpers';

let context: BrowserContext;
let page: Page;
const errors: string[] = [];

let username = 'asha';

test.beforeAll(async ({ browser }, info) => {
  await makeFixtures();
  username = `asha${info.workerIndex}`;
  ({ context, page } = await newUser(browser, username, 'Asha', errors));
  // Playwright starts a new worker after a failure; give it the same library the earlier tests built.
  if (info.workerIndex > 0) await seedLibrary(page);
});
test.afterAll(() => context.close());
test.afterEach(() => {
  expect(errors.splice(0), 'no browser errors').toEqual([]);
});

const open = async (route: string) => {
  await page.goto(`/${route}`);
  await expect(page.locator('main')).toBeVisible();
};

/** Counts distinct colours so a blank canvas is detected. */
const colours = (selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      if (!canvas.width) return 0;
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4 * 97)
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return seen.size;
    });

test('every module opens without errors', async () => {
  const routes = [
    'files',
    'pdf',
    'image-editor',
    'video-editor',
    'websites',
    'chat',
    'text-chats',
    'notes',
    'tasks',
    'movies',
    'slideshows',
    'books',
    'bills',
    'api-tester',
    'custom-apis',
    'reports',
  ];
  for (const route of routes) {
    await open(route);
    await expect(page.locator('main h1').first(), route).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
});

test('files: upload, folders, search, viewer and persistence', async () => {
  await open('files');
  await upload(
    page,
    () => page.getByRole('button', { name: 'Upload', exact: true }).click(),
    'photo.png',
    'clip.webm',
    'report.pdf',
  );
  await expect(page.locator('.media-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'New folder' }).click();
  await answer(page, 'Holiday');
  await expect(page.getByRole('button', { name: /Holiday/ }).first()).toBeVisible();
  await page.getByLabel('Search all files').fill('photo');
  await expect(page.locator('.media-card')).toHaveCount(1);
  await page.getByLabel('Search all files').fill('');
  await page.getByRole('button', { name: 'Open photo' }).click();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  const heading = page.getByRole('dialog').locator('h2');
  await expect(heading).toHaveText('photo');
  // Arrow keys step through the files.
  await page.keyboard.press('ArrowRight');
  await expect(heading).not.toHaveText('photo');
  await page.keyboard.press('ArrowLeft');
  await expect(heading).toHaveText('photo');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Select photo').check();
  await page.getByRole('button', { name: 'Move to…' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Holiday/ })
    .click();
  await expect(page.locator('.media-card')).toHaveCount(2);
  const zip = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Back up all' }).click(),
  );
  expect(zip.name).toBe('studio-backup.zip');
  const JSZip = fromClient('jszip');
  const names = Object.keys((await JSZip.loadAsync(zip.bytes)).files);
  expect(names).toContain('Holiday/photo.png');
  await page.reload();
  await expect(page.locator('.media-card')).toHaveCount(2);
});

test('pdf editor: render, annotate, resume and export', async () => {
  await open('pdf');
  await page.locator('.tile-open', { hasText: 'report' }).click();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await expect.poll(() => colours('.sheet canvas')).toBeGreaterThan(1);

  await page
    .getByRole('button', { name: /Highlight/ })
    .first()
    .click();
  const word = page.locator('.sheet .textLayer span', { hasText: 'Quarterly' });
  await expect(word).toBeVisible();
  const box = (await word.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const marks = page.locator('.sheet app-annotation-layer g.mark');
  await expect(marks).toHaveCount(1);
  // The highlight must sit over the selected words.
  const mark = (await page.locator('.sheet app-annotation-layer rect').first().boundingBox())!;
  expect(Math.abs(mark.y - box.y)).toBeLessThan(box.height);
  expect(Math.abs(mark.x - box.x)).toBeLessThan(20);

  const sheet = (await page.locator('.sheet').boundingBox())!;
  const drag = async (x: number, y: number) => {
    await page.mouse.move(sheet.x + x, sheet.y + y);
    await page.mouse.down();
    await page.mouse.move(sheet.x + x + 90, sheet.y + y + 50, { steps: 5 });
    await page.mouse.up();
  };
  await page.getByRole('button', { name: /Rectangle/ }).click();
  await drag(80, 250);
  await page.getByRole('button', { name: /Pen/ }).click();
  await drag(80, 340);
  await page.getByRole('button', { name: /Arrow/ }).click();
  await drag(220, 340);
  await page.getByRole('button', { name: /Redact/ }).click();
  await drag(80, 440);
  await expect(marks).toHaveCount(5);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(marks).toHaveCount(4);
  await page.getByRole('button', { name: 'Redo' }).click();

  await page
    .getByRole('toolbar', { name: 'Annotation tools' })
    .getByRole('button', { name: 'Text', exact: true })
    .click();
  await page.mouse.click(sheet.x + 250, sheet.y + 250);
  await answer(page, 'Reviewed नमस्ते');
  await expect(marks).toHaveCount(6);

  await page.getByRole('button', { name: '⟳ Rotate' }).click();
  await page.getByRole('button', { name: '+ Blank' }).click();
  await expect(page.getByText('Page 2 of 3')).toBeVisible();
  await saved(page);

  await page.reload();
  await page.getByRole('button', { name: /report.*3 pages/ }).click();
  await expect(page.getByText('Page 1 of 3')).toBeVisible();
  await expect(marks).toHaveCount(6);

  const result = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Download', exact: true }).click(),
  );
  const { PDFDocument } = fromClient('pdf-lib');
  const output = await PDFDocument.load(result.bytes);
  expect(output.getPageCount()).toBe(3);
  expect(output.getPage(0).getRotation().angle).toBe(90);
  await page.getByRole('button', { name: 'Save to library' }).click();
  await expect(page.getByText(/Saved a new PDF/)).toBeVisible();
});

test('image editor: design, edit layers, crop and export', async () => {
  await open('image-editor');
  await page.getByRole('button', { name: /photo/ }).first().click();
  const canvas = 'canvas[aria-label="Design canvas"]';
  await expect.poll(() => colours(canvas)).toBeGreaterThan(3);
  const items = page.locator('aside[aria-label="Add and layers"] .list-item');

  await page.getByRole('button', { name: 'Top caption' }).click();
  await page.getByLabel('Layer text').fill('HELLO WORLD');
  await page.getByRole('button', { name: 'Add star' }).click();
  await page.getByText('Stickers').click();
  await page.getByRole('button', { name: '🔥' }).click();
  await expect(items).toHaveCount(3);

  const selection = page.locator('.selection');
  const before = (await selection.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 80, before.y + before.height / 2 + 40, {
    steps: 6,
  });
  await page.mouse.up();
  const after = (await selection.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(60);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => Math.abs((await selection.boundingBox())!.x - before.x))
    .toBeLessThan(2);

  await page.getByRole('button', { name: /Brush/ }).click();
  const area = (await page.locator(canvas).boundingBox())!;
  await page.mouse.move(area.x + 40, area.y + 40);
  await page.mouse.down();
  await page.mouse.move(area.x + 200, area.y + 120, { steps: 8 });
  await page.mouse.up();
  await expect(items).toHaveCount(4);

  await page.getByRole('button', { name: 'Photo and canvas settings' }).click();
  await page.getByRole('button', { name: 'Vintage' }).click();
  await page.getByRole('button', { name: '⟳ 90°' }).click();
  await page.getByRole('button', { name: /Crop/ }).click();
  const rotated = (await page.locator(canvas).boundingBox())!;
  await page.mouse.move(rotated.x + 20, rotated.y + 20);
  await page.mouse.down();
  await page.mouse.move(rotated.x + rotated.width - 20, rotated.y + rotated.height - 60, {
    steps: 6,
  });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Apply crop' }).click();
  await expect.poll(() => colours(canvas)).toBeGreaterThan(3);

  const png = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Download', exact: true }).click(),
  );
  expect(png.bytes.subarray(1, 4).toString()).toBe('PNG');
  // Cropped and rotated: portrait, and smaller than the 360 x 640 rotated source.
  expect(png.bytes.readUInt32BE(16)).toBeLessThan(360);
  expect(png.bytes.readUInt32BE(20)).toBeLessThan(640);
  await page.getByRole('button', { name: 'Save to library' }).click();
  await expect(page.getByText(/Saved a new picture/)).toBeVisible();
  await saved(page);
});

test('video editor: preview, split, caption and real export', async () => {
  await open('video-editor');
  await page.getByRole('button', { name: /clip/ }).first().click();
  const preview = 'canvas[aria-label="Video preview"]';
  await expect(page.getByText('/ 0:04.0')).toBeVisible();
  await expect.poll(() => colours(preview)).toBeGreaterThan(3);
  await page.getByRole('button', { name: '▶ Play' }).click();
  await expect
    .poll(async () => Number(await page.getByLabel('Playhead').inputValue()))
    .toBeGreaterThan(0.8);
  await page.getByRole('button', { name: '⏸ Pause' }).click();
  await page.getByLabel('Playhead').fill('2');
  await page.getByRole('button', { name: /Split at playhead/ }).click();
  await expect(page.locator('.timeline .clip')).toHaveCount(2);
  await page.getByLabel('Speed').selectOption({ label: '2×' });
  await page.getByRole('button', { name: '+ Caption' }).click();
  await page.getByLabel('Caption text').fill('Test caption');
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(page.getByText('Export complete.')).toBeVisible({ timeout: 60_000 });
});

test('chat: two users exchange, edit and delete messages live', async ({ browser }) => {
  const other = await newUser(browser, `ravi${test.info().workerIndex}`, 'Ravi', errors);
  try {
    // Ravi is on another page: still online, and told about new messages by the sidebar badge.
    await open('chat');
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByRole('dialog').getByRole('checkbox', { name: /Ravi/ }).last().check();
    await page.getByRole('button', { name: 'Start chat' }).click();
    await expect(page.locator('.thread-pane header small')).toHaveText('Online');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Are you there?');
    await composer.press('Enter');
    await expect(other.page.getByRole('link', { name: /Chat.*1 unread/ }).first()).toBeVisible();
    await other.page
      .getByRole('link', { name: /Chat.*1 unread/ })
      .first()
      .click();
    await other.page.getByRole('button', { name: /Asha/ }).first().click();
    await expect(other.page.getByRole('link', { name: /unread messages/ })).toHaveCount(0);

    await composer.fill('Hello Ravi');
    await composer.press('Enter');
    const theirs = other.page.locator('.message');
    await expect(theirs.filter({ hasText: 'Hello Ravi' })).toBeVisible();
    await expect(page.getByText('Seen by Ravi')).toBeVisible();

    await theirs.filter({ hasText: 'Hello Ravi' }).hover();
    await theirs.filter({ hasText: 'Hello Ravi' }).getByRole('button', { name: 'Reply' }).click();
    const reply = other.page.getByRole('textbox', { name: 'Message', exact: true });
    await reply.pressSequentially('Hi Asha!');
    await expect(page.getByText('Ravi is typing…')).toBeVisible();
    await reply.press('Enter');
    await expect(page.locator('.message blockquote')).toContainText('Hello Ravi');

    const mine = page.locator('.message.mine', { hasText: 'Hello Ravi' });
    await mine.hover();
    await mine.getByRole('button', { name: 'React' }).click();
    await mine.getByRole('button', { name: '👍' }).click();
    await expect(other.page.locator('.reaction', { hasText: '👍 1' })).toBeVisible();

    await mine.hover();
    await mine.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Edit message').fill('Hello Ravi (edited)');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(theirs.filter({ hasText: 'Hello Ravi (edited)' }).first()).toBeVisible();
    await expect(theirs.getByText('· edited').first()).toBeVisible();

    await upload(
      page,
      () => page.getByRole('button', { name: 'Send pictures or videos' }).click(),
      'photo.png',
    );
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const image = other.page.locator('.message img').first();
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(640);

    const withImage = page.locator('.message.mine').filter({ has: page.locator('img') });
    await withImage.hover();
    await withImage.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(other.page.getByText('This message was deleted')).toBeVisible();
    await expect(other.page.locator('.message img')).toHaveCount(0);
  } finally {
    await other.context.close();
  }
});

test('website editor: template, canvas editing and export', async () => {
  await open('websites');
  await page.getByRole('button', { name: 'New website' }).click();
  await page.getByLabel('Website name').fill('Acme');
  await page.getByLabel('Start from').selectOption('Business');
  await page.getByRole('button', { name: 'Create website' }).click();
  const canvas = page.frameLocator('iframe[title="Page canvas"]');
  await expect(canvas.getByRole('heading', { name: 'Welcome to Acme' })).toBeVisible();
  await canvas.getByRole('heading', { name: 'Why choose us' }).click();
  // Act like a person: wait for the heading's settings, click into the box, then type.
  const headingText = page
    .locator('aside[aria-label="Settings"]')
    .getByRole('textbox', { name: 'Text', exact: true });
  await expect(headingText).toHaveValue('Why choose us');
  await headingText.click();
  await headingText.press('Control+a');
  await headingText.pressSequentially('Why Acme');
  await expect(canvas.getByRole('heading', { name: 'Why Acme' })).toBeVisible();
  await page.getByRole('button', { name: /Gallery/ }).click();
  await expect(canvas.getByText('Add pictures to the gallery')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(canvas.getByText('Add pictures to the gallery')).toHaveCount(0);
  await page.getByRole('button', { name: 'mobile' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(
    page.frameLocator('iframe[title="Website preview"]').getByRole('heading', { name: 'Why Acme' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  const zip = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Export website' }).click(),
  );
  const JSZip = fromClient('jszip');
  const archive = await JSZip.loadAsync(zip.bytes);
  expect(await archive.file('index.html').async('string')).toContain('Why Acme');
  expect(archive.file('style.css')).toBeTruthy();
  await saved(page);
});

test('notes and tasks persist after reload', async () => {
  await open('notes');
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Shopping');
  await page.getByRole('textbox', { name: 'Text' }).pressSequentially('Buy milk and bread');
  await page.getByRole('button', { name: '+ Checklist' }).click();
  await page.getByLabel('Checklist item').fill('Eggs');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await saved(page);
  await page.reload();
  await expect(page.locator('.note')).toContainText('Buy milk and bread');
  await expect(page.locator('.note')).toContainText('Eggs');

  await open('tasks');
  await expect(page.locator('.column')).toHaveCount(3);
  await page.getByLabel('Add a task to New tasks').fill('Write docs');
  await page.getByLabel('Add a task to New tasks').press('Enter');
  await expect(page.locator('.task')).toContainText('Write docs');
  const card = (await page.locator('.task').boundingBox())!;
  const target = (await page.locator('.column').nth(2).locator('.cards').boundingBox())!;
  await page.mouse.move(card.x + card.width / 2, card.y + card.height - 8);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 20, { steps: 15 });
  // The drop is reported after the drag animation; wait for the new order to reach the server.
  const reordered = page.waitForResponse('**/api/docs/tasks/reorder');
  await page.mouse.up();
  await reordered;
  await expect(page.locator('.column').nth(2)).toContainText('Write docs');
  await saved(page);
  await page.reload();
  await expect(page.locator('.column').nth(2)).toContainText('Write docs');
});

test('text chat and bills', async () => {
  await open('text-chats');
  await page.getByRole('button', { name: 'New from text' }).click();
  await page.getByLabel('Name').fill('Interview');
  await page
    .getByLabel('Text', { exact: true })
    .fill('First sentence. Second sentence?\nThird line');
  await page.getByRole('button', { name: 'Create bubbles' }).click();
  await expect(page.locator('.bubble')).toHaveCount(3);
  await page.locator('.bubble').first().getByRole('button', { name: 'Highlight' }).click();
  await expect(page.locator('.bubble.highlighted')).toHaveCount(1);
  await saved(page);

  await open('bills');
  await page.getByRole('button', { name: 'New bill' }).click();
  await page.getByLabel('Recipient name').fill('Kumar Traders');
  await page.getByLabel('Item description').fill('Window frames');
  await page.getByLabel('Amount', { exact: true }).fill('1,000');
  await page.getByRole('button', { name: '+ Add item' }).click();
  await page.getByLabel('Item description').nth(1).fill('Fitting');
  await page.getByLabel('Amount', { exact: true }).nth(1).fill('250.50');
  await expect(page.locator('.sum.total')).toContainText('1,250.50');
  const photo = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Export photo' }).click(),
  );
  expect(photo.bytes.length).toBeGreaterThan(5000);
  await saved(page);
  await page.reload();
  await expect(page.locator('.tile')).toContainText('1,250.50');
});

test('books: add, drag, paginate and read', async () => {
  await open('books');
  await page.getByRole('button', { name: 'New book' }).click();
  await answer(page, 'My Story');
  const elements = page.locator('.book-canvas .element');
  await expect(elements).toHaveCount(1);
  await page.getByRole('button', { name: '+ Add page' }).click();
  await expect(page.locator('.page-thumb')).toHaveCount(2);
  await page.getByRole('button', { name: '+ Text' }).click();
  await page.getByRole('textbox', { name: 'Text', exact: true }).fill('Once upon a time');
  await page.getByRole('button', { name: '+ Image' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^photo/ })
    .first()
    .click();
  await expect(elements).toHaveCount(2);
  const picture = elements.nth(1);
  const start = (await picture.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  expect((await picture.boundingBox())!.y - start.y).toBeGreaterThan(90);
  await page.getByRole('button', { name: 'Read' }).click();
  await expect(page.locator('.reader')).toContainText('Once upon a time');
  await page.getByRole('button', { name: '← Previous' }).click();
  await expect(page.locator('.reader app-page-view').first()).toContainText('My Story');
  await saved(page);
});

test('movies and slideshows: build, play and export', async () => {
  await open('movies');
  await page.getByRole('button', { name: 'New movie' }).click();
  await answer(page, 'Short film');
  await page.getByRole('button', { name: '+ Picture or video' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^photo/ })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: /^Add/ }).click();
  await page.getByRole('button', { name: '+ Speech bubble' }).click();
  await page.getByLabel('Bubble text').fill('Action!');
  const preview = 'canvas[aria-label="Movie preview"]';
  await expect.poll(() => colours(preview)).toBeGreaterThan(3);
  await page.locator('.scene').first().click();
  await page
    .locator('app-slider', { hasText: 'Length' })
    .locator('input[type="number"]')
    .fill('1.5');
  await page
    .locator('app-slider', { hasText: 'Length' })
    .locator('input[type="number"]')
    .press('Tab');
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(page.getByText('Export complete.')).toBeVisible({ timeout: 60_000 });

  await open('slideshows');
  await page.getByRole('button', { name: 'New slideshow' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Memories');
  await page.getByLabel('Add a whole folder').selectOption({ label: 'Holiday' });
  await expect(page.locator('.slide-list .list-item')).toHaveCount(1);
  await page.getByRole('button', { name: 'Create slideshow' }).click();
  await expect(page.locator('.scene')).toHaveCount(1);
  await page.getByRole('button', { name: '▶ Play' }).click();
  await expect
    .poll(async () => Number(await page.getByLabel('Playhead').inputValue()))
    .toBeGreaterThan(0.5);
  await page.getByRole('button', { name: '⏸ Pause' }).click();
  await saved(page);
});

test('custom API, API tester and reports', async () => {
  await open('custom-apis');
  await page.getByRole('button', { name: 'New endpoint' }).click();
  await page.getByLabel('Name').fill('Users');
  await page.getByLabel('Path').fill('users/list');
  await page.getByLabel('Response body').fill('{"users":["asha"]}');
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  const url = (await page.locator('.url').textContent())!.trim();

  await open('api-tester');
  await page.getByLabel('URL').fill(url);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('200 OK')).toBeVisible();
  await expect(page.locator('pre')).toContainText('"asha"');
  await expect(page.locator('aside .list-item')).toHaveCount(1);

  await open('reports');
  await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Holiday' }).first()).toBeVisible();
  const csv = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Export CSV' }).click(),
  );
  expect(csv.bytes.toString()).toContain('Websites,sites,1');
});

test('mobile layout has a usable menu and no sideways scrolling', async () => {
  await page.setViewportSize({ width: 390, height: 780 });
  for (const route of ['files', 'notes', 'chat', 'reports', 'pdf', 'bills']) {
    await open(route);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const overflow = await page.locator('.main').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, route).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: /Tasks/ }).click();
  await expect(page).toHaveURL(/tasks$/);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('backend binding: everything the modules created is stored by the server', async () => {
  await open('files');
  const get = async (url: string) => (await page.request.get(url)).json();
  const collections = [
    'folders',
    'notes',
    'bills',
    'books',
    'bookPages',
    'taskSections',
    'tasks',
    'textChats',
    'movies',
    'slideshows',
    'sites',
    'sitePages',
    'pdfProjects',
    'imageProjects',
    'videoProjects',
    'customEndpoints',
    'apiRequests',
  ];
  const empty: string[] = [];
  for (const name of collections) {
    const rows = await get(`/api/docs/${name}`);
    if (!rows.length) empty.push(name);
  }
  expect(empty, 'collections the app never saved to').toEqual([]);
  expect((await get('/api/media')).length).toBeGreaterThan(5);
  expect((await get('/api/chat/conversations')).length).toBe(1);
  expect((await get('/api/workspaces')).length).toBe(1);
});

test('sign out protects the app and sign in restores it', async () => {
  await open('files');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
  await page.goto('/notes');
  await page.waitForURL('**/login');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/workspaces');
  await page.getByRole('button', { name: /^Asha workspace/ }).click();
  await page.waitForURL('**/files');
});
