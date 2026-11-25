/** The features carried over from the reference project, each used the way a person would. */
import type { BrowserContext, Page } from '@playwright/test';
import {
  answer,
  downloadBytes,
  expect,
  makeFixtures,
  nativeDrag,
  nativeDragPoints,
  newUser,
  saved,
  seedLibrary,
  test,
  upload,
} from './helpers';

let context: BrowserContext;
let page: Page;
const errors: string[] = [];

test.beforeAll(async ({ browser }, info) => {
  await makeFixtures();
  ({ context, page } = await newUser(browser, `meera${info.workerIndex}`, 'Meera', errors));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedLibrary(page);
});
test.afterAll(() => context.close());
test.afterEach(() => {
  expect(errors.splice(0), 'no browser errors').toEqual([]);
});

const number = (label: string) =>
  page.locator('app-slider', { hasText: label }).locator('input[type="number"]').first();
const setNumber = async (label: string, value: string) => {
  await number(label).fill(value);
  await number(label).press('Tab');
};

test('login offers Google sign-in, disabled until it is set up', async ({ browser }) => {
  const visitor = await browser.newContext();
  const login = await visitor.newPage();
  await login.goto('/login');
  await expect(login.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await expect(login.getByText('Google sign-in is not set up')).toBeVisible();
  await visitor.close();
});

test('customer details and photo', async () => {
  await page.goto('/workspaces');
  await page.getByRole('button', { name: 'Options for Meera' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await upload(page, () => page.getByRole('button', { name: 'Add photo' }).click(), 'photo.png');
  await expect(page.getByAltText('Current customer photo')).toBeVisible();
  await page.getByRole('dialog').getByLabel('Customer description').fill('Our first customer');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Our first customer')).toBeVisible();
  await page.getByRole('button', { name: /Our first customer/ }).click();
  await page.waitForURL('**/files');
  await expect(page.locator('.sidebar-foot img')).toBeVisible();
});

test('files: right-click menus, folder colour and ZIP, move to a new folder', async () => {
  await page.goto('/files');
  await page.locator('.media-card', { hasText: 'report' }).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Open',
    'Edit',
    'Download',
    'Rename',
    'Move to…',
    'Delete',
  ]);
  const file = await downloadBytes(page, () =>
    menu.getByRole('menuitem', { name: 'Download' }).click(),
  );
  expect(file.name).toBe('report.pdf');
  await expect(menu).toHaveCount(0);

  const folder = page.locator('.tile.folder', { hasText: 'Holiday' });
  await expect(folder).toContainText('1 file');
  await expect(folder.locator('img.cover')).toBeVisible();
  await folder.click({ button: 'right' });
  await menu.getByRole('button', { name: 'Colour #10b981' }).click();
  await expect(folder).toHaveCSS('border-top-color', 'rgb(16, 185, 129)');
  await page.getByRole('button', { name: 'Options for folder Holiday' }).click();
  const zip = await downloadBytes(page, () =>
    menu.getByRole('menuitem', { name: 'Download ZIP' }).click(),
  );
  expect(zip.name).toBe('Holiday.zip');

  await page.getByRole('button', { name: 'More options for report' }).click();
  await menu.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('button', { name: '＋ New folder…' }).click();
  await answer(page, 'Documents');
  await expect(page.locator('.tile.folder', { hasText: 'Documents' })).toContainText('1 file');
});

test('pdf module browses the same folders', async () => {
  await page.goto('/pdf');
  await expect(page.locator('.tile', { hasText: 'report' })).toHaveCount(0);
  await page.getByRole('button', { name: /Documents/ }).click();
  await expect(page.locator('.tile-open', { hasText: 'report' })).toBeVisible();
});

test('image editor: sections, photo body, magic wand, lasso and done state', async () => {
  await page.goto('/image-editor');
  await page.getByRole('button', { name: /photo/ }).first().click();
  const canvas = page.locator('canvas[aria-label="Design canvas"]');
  const size = () => canvas.evaluate((el: HTMLCanvasElement) => [el.width, el.height]);
  await expect.poll(size).toEqual([640, 360]);
  for (const name of ['Header', 'Sub-header', 'Left side', 'Right side', 'Caption', 'Footer']) {
    await page.locator('summary', { hasText: new RegExp(`^${name}$`) }).click();
    await page.getByLabel(`Show ${name}`, { exact: true }).check();
  }
  await expect.poll(async () => (await size())[0]!).toBeGreaterThan(640);
  await page.getByLabel('Left side text', { exact: true }).fill('Side words');
  await page.locator('summary', { hasText: 'Photo body' }).click();
  await setNumber('Photo border', '8');

  const layers = page.locator('aside[aria-label="Add and layers"] .list-item');
  await page.getByRole('button', { name: /Lasso/ }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.getByRole('button', { name: 'Cut out as layer' })).toBeEnabled();
  await page.getByRole('button', { name: 'Cut out as layer' }).click();
  await expect(layers).toHaveCount(1);

  await page.getByRole('button', { name: /Lasso/ }).click();
  await page.getByRole('button', { name: 'Freehand' }).click();
  await page.mouse.move(box.x + 150, box.y + 120);
  await page.mouse.down();
  for (const [x, y] of [
    [300, 130],
    [260, 240],
    [160, 220],
  ])
    await page.mouse.move(box.x + x!, box.y + y!, { steps: 5 });
  await page.mouse.up();
  const before = await page.locator('.handle.corner').first().boundingBox();
  expect(before).toBeTruthy();
  await page.getByRole('button', { name: 'Save as new picture' }).click();
  await expect(page.getByText('Saved the selection as a new picture')).toBeVisible();

  await page.getByRole('button', { name: 'Save to library' }).click();
  await expect(page.getByText(/Saved a new picture to your library/)).toBeVisible();
  await saved(page);
  await page.getByRole('button', { name: '← Designs' }).click();
  await expect(page.locator('.tile', { hasText: 'photo' })).toContainText('Done · edit again');
});

test('video editor: top text, new effects export, done state', async () => {
  await page.goto('/video-editor');
  await page.getByRole('button', { name: /clip/ }).first().click();
  await expect(page.getByText('/ 0:04.0')).toBeVisible();
  await page.getByRole('button', { name: 'Top text' }).click();
  await expect(page.getByLabel('Caption text')).toHaveValue('TOP TEXT');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('summary', { hasText: 'Picture adjustments' }).click();
  await setNumber('Hue', '60');
  await setNumber('Sepia', '50');
  await setNumber('Pixelate', '8');
  await setNumber('Vignette', '70');
  await page.getByLabel('Invert colours').check();
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(page.getByText('Export complete.')).toBeVisible({ timeout: 60_000 });
  await saved(page);
  await page.getByRole('button', { name: '← Videos' }).click();
  await expect(page.locator('.tile', { hasText: 'clip' })).toContainText('Done · edit again');
});

test('chat group picture, description and PDF export', async ({ browser }) => {
  const one = await newUser(browser, `kiran${test.info().workerIndex}`, 'Kiran', errors);
  const two = await newUser(browser, `divya${test.info().workerIndex}`, 'Divya', errors);
  try {
    await page.goto('/chat');
    await page.getByRole('button', { name: 'New chat' }).click();
    await page.getByRole('dialog').getByRole('checkbox', { name: /Kiran/ }).last().check();
    await page.getByRole('dialog').getByRole('checkbox', { name: /Divya/ }).last().check();
    await page.getByRole('dialog').getByLabel('Group name').fill('Design team');
    await page.getByRole('button', { name: 'Create group' }).click();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('नमस्ते team 👋');
    await composer.press('Enter');
    await expect(page.locator('.message', { hasText: 'नमस्ते' })).toBeVisible();

    await page.getByRole('button', { name: 'Members' }).click();
    await page.getByLabel('Group description').fill('Plans and drafts');
    await page.getByLabel('Group description').blur();
    await upload(
      page,
      () => page.getByRole('button', { name: 'Add picture' }).click(),
      'photo.png',
    );
    await expect(page.getByAltText('Group picture')).toBeVisible();
    await expect(page.locator('.conversation img.group-picture')).toBeVisible();

    await one.page.goto('/chat');
    await one.page.getByRole('button', { name: /Design team/ }).click();
    await expect(one.page.locator('.description')).toHaveText('Plans and drafts');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const pdf = await downloadBytes(page, () =>
      page.getByRole('menuitem', { name: 'Export as PDF' }).click(),
    );
    expect(pdf.name).toBe('Design team.pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.bytes.length).toBeGreaterThan(5000);
  } finally {
    await one.context.close();
    await two.context.close();
  }
});

test('text chat copy and sizes; task status and card picture', async () => {
  await page.goto('/text-chats');
  await page.getByRole('button', { name: 'New from text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Copy this sentence.');
  await page.getByRole('button', { name: 'Create bubbles' }).click();
  await page.locator('.bubble').getByRole('button', { name: 'Copy' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Copy this sentence.');
  await page.locator('.bubble').getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('button', { name: 'Largest text' })).toBeVisible();
  await saved(page);

  await page.goto('/tasks');
  await page.getByLabel('Add a task to New tasks').fill('Pick a cover');
  await page.getByLabel('Add a task to New tasks').press('Enter');
  const card = page.locator('.task');
  await expect(card.locator('.status')).toHaveText('Started');
  await card.getByRole('checkbox').check();
  await expect(card.locator('.status')).toHaveText('Completed');
  await card.locator('.tile-open').click();
  await page.getByRole('button', { name: '+ From library' }).click();
  await page
    .getByRole('dialog')
    .last()
    .getByRole('button', { name: /^photo/ })
    .first()
    .click();
  await page.getByRole('dialog').last().getByRole('button', { name: /^Add/ }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card.locator('img.task-cover')).toBeVisible();
  await saved(page);
});

test('books: crop a picture by dragging', async () => {
  await page.goto('/books');
  await page.getByRole('button', { name: 'New book' }).click();
  await answer(page, 'Album');
  await expect(page.locator('.book-canvas .element')).toHaveCount(1);
  await page.getByRole('button', { name: '+ Image' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^photo/ })
    .first()
    .click();
  await expect(page.locator('.book-canvas .element')).toHaveCount(2);
  await page.getByRole('button', { name: 'Crop by dragging' }).click();
  const grip = (await page.locator('app-crop-modal .grip').boundingBox())!;
  await page.mouse.move(grip.x + 9, grip.y + 9);
  await page.mouse.down();
  await page.mouse.move(grip.x - 150, grip.y - 80, { steps: 6 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Apply crop' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(Number(await number('Visible width').inputValue())).toBeLessThan(90);
  await saved(page);
});

test('movies: title bar styling, bubble tools, replace and edit a picture', async () => {
  await page.goto('/movies');
  await page.getByRole('button', { name: 'New movie' }).click();
  await answer(page, 'Parity film');
  await page.getByRole('button', { name: '+ Picture or video' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^photo/ })
    .first()
    .click();
  await page.getByRole('dialog').getByRole('button', { name: /^Add/ }).click();
  await page.locator('summary', { hasText: 'Movie settings' }).click();
  await page.getByLabel('Show Title bar on top').check();
  await page.getByLabel('Title bar on top text', { exact: true }).fill('Opening');
  await expect(page.getByLabel('Title bar on top font')).toBeVisible();

  await page.getByRole('button', { name: '+ Speech bubble' }).click();
  await page.getByRole('button', { name: 'Pin to top' }).click();
  await expect(number('Vertical')).toHaveValue('8');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(
    page.locator('aside[aria-label="Movie settings"] .list-item', { hasText: '💬' }),
  ).toHaveCount(2);

  const object = page.locator('aside[aria-label="Movie settings"] .list-item', { hasText: '🖼' });
  await object.getByRole('button').click();
  await page.getByRole('button', { name: 'Edit image' }).click();
  const editor = page.locator('.embedded-editor');
  await expect(editor.locator('canvas[aria-label="Design canvas"]')).toBeVisible();
  await editor.getByRole('button', { name: '⟳ 90°' }).click();
  await editor.getByRole('button', { name: 'Save to library' }).click();
  await expect(editor).toHaveCount(0);
  await expect(object).toContainText('(edited)');
  await object.getByRole('button').click();
  await page.getByRole('button', { name: 'Replace with…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^clip/ }).first().click();
  await expect(
    page.locator('aside[aria-label="Movie settings"] .list-item', { hasText: '🎬' }),
  ).toContainText('clip');
  await saved(page);
});

test('website: drag onto the canvas, move blocks, tabs, rename a page, favicon', async () => {
  await page.goto('/websites');
  await page.getByRole('button', { name: 'New website' }).click();
  await page.getByLabel('Website name').fill('Drag');
  await page.getByRole('button', { name: 'Create website' }).click();
  const frame = page.frameLocator('iframe[title="Page canvas"]');
  await expect(frame.getByText('This page is empty')).toBeVisible();
  const palette = (name: RegExp) =>
    page.locator('aside[aria-label="Pages and blocks"] .palette').getByRole('button', { name });

  expect(await nativeDrag(page, palette(/Heading/), frame.locator('#canvas'))).toContain(
    'application/x-studio-new-block',
  );
  await expect(frame.getByRole('heading', { name: 'Section heading' })).toBeVisible();
  // Dropping on the empty space below the content adds the block at the end.
  // The "empty page" area below the heading is plain background.
  await nativeDrag(page, palette(/Tabs/), page.locator('iframe[title="Page canvas"]'));
  await expect(frame.locator('.tabs label')).toHaveCount(2);
  await expect(frame.locator('#canvas > .block').last()).toHaveClass(/block-tabs/);

  // Drag the heading from above the tabs into the first tab.
  const types = await nativeDrag(
    page,
    frame.getByRole('heading', { name: 'Section heading' }),
    frame.locator('.tab-panel').first(),
  );
  expect(types).toContain('application/x-studio-move-block');
  await expect(
    frame.locator('.tab-panel').first().getByRole('heading', { name: 'Section heading' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(frame.locator('.tab-panel').first().getByRole('heading')).toHaveCount(0);

  await page.locator('aside[aria-label="Pages and blocks"] .pick', { hasText: 'Tabs' }).click();
  await page.getByRole('button', { name: '+ Into tab 2' }).click();
  await palette(/Button/).click();
  await expect(frame.locator('.tab-panel').nth(1).getByText('Click me')).toHaveCount(1);

  await page.locator('aside[aria-label="Pages and blocks"] .pick', { hasText: 'Home' }).dblclick();
  await answer(page, 'Start');
  await expect(
    page.locator('aside[aria-label="Pages and blocks"] .pick', { hasText: 'Start (home)' }),
  ).toBeVisible();
  await page.locator('aside[aria-label="Pages and blocks"] .pick', { hasText: 'Tabs' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Choose icon' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^photo/ })
    .first()
    .click();
  const zip = await downloadBytes(page, () =>
    page.getByRole('button', { name: 'Export website' }).click(),
  );
  const { fromClient } = await import('./helpers');
  const archive = await fromClient('jszip').loadAsync(zip.bytes);
  expect(await archive.file('index.html').async('string')).toContain('rel="icon"');
  await saved(page);
  // Playwright adds its own listeners inside frames, and this script-free sandbox rightly refuses to run
  // them. The next test proves the app itself logs nothing here.
  const fromTestTool = "Blocked script execution in 'about:srcdoc'";
  errors.splice(0, errors.length, ...errors.filter((message) => !message.includes(fromTestTool)));
});

test('website canvas: real click and drag work without any errors', async () => {
  await page.goto('/websites');
  await page.getByRole('button', { name: 'New website' }).click();
  await page.getByLabel('Website name').fill('Clean');
  await page.getByRole('button', { name: 'Create website' }).click();
  const palette = (name: RegExp) =>
    page.locator('aside[aria-label="Pages and blocks"] .palette').getByRole('button', { name });
  await palette(/Heading/).click();
  await palette(/Button/).click();

  // Positions come from the parent page, so the test tool never reaches into the frame.
  const read = <T>(script: string) =>
    page.evaluate(
      ([code]) =>
        new Function('doc', 'outer', code!)(
          document.querySelector<HTMLIFrameElement>('iframe[title="Page canvas"]')!.contentDocument,
          document.querySelector('iframe[title="Page canvas"]')!.getBoundingClientRect(),
        ),
      [script],
    ) as Promise<T>;
  const centre = (selector: string) =>
    read<{ x: number; y: number }>(
      `const b = doc.querySelector('${selector}').getBoundingClientRect(); return { x: outer.left + b.left + b.width / 2, y: outer.top + b.top + b.height / 2 };`,
    );
  const order = () =>
    read<string>(
      `return [...doc.querySelectorAll('#canvas > .block')].map((e) => e.className.split(' ')[1]).join();`,
    );
  await expect.poll(order).toBe('block-heading,block-button');

  const heading = await centre('h2');
  await page.mouse.click(heading.x, heading.y);
  await expect(page.locator('aside[aria-label="Settings"] h3').first()).toHaveText('Heading');
  const button = await centre('.block-button');
  await nativeDragPoints(page, await centre('h2'), { x: button.x, y: button.y + 8 });
  await expect.poll(order).toBe('block-button,block-heading');
  await saved(page);
});

test('API tools: try it, new request and clear history; report counts', async () => {
  await page.goto('/custom-apis');
  await page.getByRole('button', { name: 'New endpoint' }).click();
  await page.getByLabel('Name').fill('Ping');
  await page.getByLabel('Path').fill('ping');
  await page.getByLabel('Response body').fill('{"pong":true}');
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  await page.getByRole('button', { name: 'Try it' }).click();
  await expect(page.getByRole('dialog')).toContainText('200 OK');
  await expect(page.getByRole('dialog')).toContainText('"pong": true');
  await page.keyboard.press('Escape');
  const url = (await page.locator('.card .url').textContent())!.trim();

  await page.goto('/api-tester');
  await page.getByLabel('URL').fill(url);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('200 OK')).toBeVisible();
  await page.locator('summary', { hasText: 'Response headers' }).click();
  await page.getByRole('button', { name: 'Copy headers' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('Content-Type');
  await page.getByRole('button', { name: 'New request' }).click();
  await expect(page.getByLabel('URL')).toHaveValue('');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('aside .list-item')).toHaveCount(0);

  await page.goto('/reports');
  await expect(page.getByText('pdfHighlights')).toBeVisible();
  await expect(page.getByText('blocks', { exact: true })).toBeVisible();
});
