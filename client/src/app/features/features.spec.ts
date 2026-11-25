import { base64Bytes, bodyKind, buildHeaders } from './api/request-utils';
import { money, nextBillNumber, parseAmount, totals, type BillItem } from './bills/bill-math';
import { mergeHistory, reactionGroups, upsertMessage, type Message } from './chat/chat-model';
import { colorName, folderPath, folderTree } from './files/library-utils';
import {
  applyCrop,
  createLayer,
  emptyImageDoc,
  flip,
  hitTest,
  layout,
  photoSize,
  resetCrop,
  resizeLayer,
  rotateQuarter,
} from './image/model';
import { wrapText } from './image/text-layout';
import {
  animationState,
  buildSlideshow,
  createObject,
  createScene,
  sceneAt,
  setDuration,
  transitionState,
} from './movies/model';
import { toCsv } from './reports/reports';
import { splitSentences } from './text-chats/split';
import {
  createClip,
  cropOf,
  locate,
  splitAt,
  toSpec,
  totalLength,
  trim,
  emptyVideoDoc,
} from './video/timeline';

describe('bills', () => {
  const item = (amount: string, fullWidth = false): BillItem => ({
    id: amount,
    text: '',
    amount,
    fullWidth,
    align: 'left',
    indent: 0,
    amountAlign: 'right',
  });

  it('reads common amount styles and rejects words', () => {
    expect(parseAmount('1,250.50')).toBe(1250.5);
    expect(parseAmount('Rs. 900/-')).toBe(900);
    expect(parseAmount('₹ 1,00,000')).toBe(100000);
    expect(parseAmount('as per actuals')).toBeNull();
    expect(parseAmount('2 x 500')).toBe(null);
    expect(parseAmount('')).toBeNull();
  });

  it('totals without floating-point drift, applying discount before tax', () => {
    expect(totals([item('0.1'), item('0.2'), item('99', true)], 0, 0).total).toBe(0.3);
    expect(totals([item('1000')], 18, 100)).toMatchObject({
      subtotal: 1000,
      discount: 100,
      tax: 162,
      total: 1062,
    });
    expect(totals([item('50')], 0, 500).total).toBe(0);
    expect(money(100000, '₹')).toBe('₹ 1,00,000.00');
  });

  it('numbers bills after the highest one', () => {
    expect(nextBillNumber(['3', 'INV-12', ''])).toBe('13');
    expect(nextBillNumber([])).toBe('1');
  });
});

describe('text chat splitting', () => {
  it('splits sentences and lines, including Hindi punctuation', () => {
    expect(splitSentences('Hello there. How are you?\nFine!')).toEqual([
      'Hello there.',
      'How are you?',
      'Fine!',
    ]);
    expect(splitSentences('यह पहला है। यह दूसरा है।')).toHaveLength(2);
    expect(splitSentences('  \n\n ')).toEqual([]);
  });
});

describe('text wrapping', () => {
  it('wraps words, keeps blank lines and breaks very long words', () => {
    const measure = (t: string) => t.length;
    expect(wrapText('aaa bbb ccc', 7, measure)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapText('a\n\nb', 7, measure)).toEqual(['a', '', 'b']);
    expect(wrapText('abcdefghij', 4, measure)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

describe('image model', () => {
  const doc = () => ({
    ...emptyImageDoc(800, 600),
    layers: [createLayer('shape', { x: 400, y: 300, w: 100, h: 50 })],
  });

  it('keeps layers over the same content when cropping and un-cropping', () => {
    const cropped = applyCrop(doc(), { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    expect(photoSize(cropped)).toEqual({ width: 400, height: 300 });
    expect(cropped.layers[0]).toMatchObject({ x: 200, y: 0 });
    expect(resetCrop(cropped).layers[0]).toMatchObject({ x: 400, y: 300 });
  });

  it('returns to the start after four quarter turns', () => {
    let current = applyCrop(doc(), { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
    const start = current;
    current = rotateQuarter(current, true);
    expect(photoSize(current)).toEqual({ width: 300, height: 400 });
    for (let i = 0; i < 3; i++) current = rotateQuarter(current, true);
    expect(current.rotation).toBe(0);
    expect(current.crop!.x).toBeCloseTo(start.crop!.x);
    expect(current.layers[0]!.x).toBeCloseTo(start.layers[0]!.x);
    expect(current.layers[0]!.y).toBeCloseTo(start.layers[0]!.y);
  });

  it('mirrors the crop when flipping', () => {
    const flipped = flip({ ...doc(), crop: { x: 0.1, y: 0, w: 0.3, h: 1 } }, 'h');
    expect(flipped.crop!.x).toBeCloseTo(0.6);
    expect(flipped.flipH).toBe(true);
  });

  it('adds header, footer and frame to the output size', () => {
    const base = doc();
    const sized = layout({
      ...base,
      sections: { ...base.sections, header: { ...base.sections.header, enabled: true, size: 50 } },
      frame: { width: 10, color: '#000', radius: 0 },
    });
    expect(sized).toMatchObject({ width: 820, height: 670, originX: 10, originY: 60 });
  });

  it('hit-tests rotated layers and skips hidden or locked ones', () => {
    const tall = createLayer('shape', { x: 100, y: 100, w: 200, h: 20, rotation: 90 });
    expect(hitTest([tall], 100, 180)?.id).toBe(tall.id);
    expect(hitTest([tall], 180, 100)).toBeNull();
    expect(hitTest([{ ...tall, locked: true }], 100, 100)).toBeNull();
  });

  it('scales text size with its box and never shrinks a layer to nothing', () => {
    const text = createLayer('text', { w: 200, h: 50, fontSize: 40 });
    expect(resizeLayer(text, 100, 0, false).fontSize).toBe(80);
    expect(resizeLayer(createLayer('shape'), -9999, -9999, false)).toMatchObject({ w: 10, h: 4 });
  });
});

describe('video timeline', () => {
  const clips = () => [{ ...createClip('a', 'video', 10), speed: 2 }, createClip('b', 'image', 0)];

  it('accounts for speed when locating the playhead', () => {
    expect(totalLength(clips())).toBe(8);
    expect(locate(clips(), 2)).toEqual({ index: 0, sourceTime: 4 });
    expect(locate(clips(), 5)).toEqual({ index: 1, sourceTime: 0 });
    expect(locate(clips(), 99)).toEqual({ index: 1, sourceTime: 3 });
    expect(locate([], 0)).toBeNull();
  });

  it('splits without changing the total length', () => {
    const split = splitAt(clips(), 2);
    expect(split).toHaveLength(3);
    expect(split[0]).toMatchObject({ start: 0, end: 4 });
    expect(split[1]).toMatchObject({ start: 4, end: 10 });
    expect(totalLength(split)).toBe(8);
    const same = clips();
    expect(splitAt(same, 0)).toBe(same);
  });

  it('keeps trim points ordered and inside the source', () => {
    const clip = createClip('a', 'video', 10);
    expect(trim(clip, 50, 10).start).toBeCloseTo(9.9);
    expect(trim(clip, 0, 99).end).toBe(10);
    expect(trim({ ...clip, start: 5 }, 5, 1).end).toBeCloseTo(5.1);
  });

  it('builds an export request with crop margins and only visible captions', () => {
    const clip = {
      ...createClip('a', 'video', 10),
      cut: { top: 10, right: 20, bottom: 0, left: 5 },
    };
    expect(cropOf(clip)).toEqual({ x: 0.05, y: 0.1, w: 0.75, h: 0.9 });
    const overlay = {
      id: 'o',
      text: 'hi',
      start: 1,
      end: 99,
      x: 0.5,
      y: 0.5,
      size: 0.1,
      color: '#fff',
      outline: '',
      background: '',
      fontFamily: 'serif',
    };
    const { spec } = toSpec(
      {
        ...emptyVideoDoc(),
        clips: [clip],
        format: 'gif',
        fps: 60,
        overlays: [overlay, { ...overlay, text: ' ' }, { ...overlay, start: 20, end: 30 }],
      },
      't',
    );
    expect(spec.overlays).toEqual([{ start: 1, end: 10 }]);
    expect(spec.fps).toBe(15);
  });
});

describe('movies', () => {
  it('finds scenes and keeps timings valid when a scene is shortened', () => {
    const scene = createScene(10);
    scene.objects = [
      createObject('image', 'm', 10),
      createObject('image', 'm', 10, { startSec: 6, endSec: 8 }),
    ];
    const shorter = setDuration(scene, 3);
    expect(shorter.objects.map((o) => o.endSec)).toEqual([3, 3]);
    expect(shorter.objects[1]!.startSec).toBeLessThan(3);
    expect(setDuration(scene, 20).objects[0]!.endSec).toBe(20);
    expect(sceneAt([createScene(2), createScene(3)], 2.5)).toEqual({ index: 1, local: 0.5 });
  });

  it('is invisible at the start of a fade and settled in the middle', () => {
    const scene = createScene(4, 'fade');
    expect(transitionState(scene, 0).alpha).toBe(0);
    expect(transitionState(scene, 2)).toEqual({ alpha: 1, dx: 0, dy: 0, scale: 1 });
    expect(
      animationState(createObject('image', 'm', 4, { animation: 'kenburns-in', intensity: 100 }), 4)
        .scale,
    ).toBeCloseTo(1.4);
  });

  it('makes one full-frame scene per slide', () => {
    const scenes = buildSlideshow(
      [
        { id: 'a', kind: 'image' },
        { id: 'b', kind: 'video', duration: 7 },
      ],
      4,
      'zoom',
    );
    expect(scenes.map((s) => s.duration)).toEqual([4, 7]);
    expect(scenes[0]!.objects[0]!.fit).toBe('contain');
  });
});

describe('chat model', () => {
  const message = (seq: number, text = `m${seq}`): Message => ({
    seq,
    id: `id${seq}`,
    conversationId: 'c',
    senderId: 'u',
    text,
    createdAt: seq,
    editedAt: null,
    deletedAt: null,
    replyTo: null,
    attachments: [],
    reactions: [],
  });

  it('keeps send order and replaces duplicates', () => {
    const list = upsertMessage(upsertMessage([message(2)], message(1)), message(2, 'edited'));
    expect(list.map((m) => m.text)).toEqual(['m1', 'edited']);
  });

  it('does not let older history overwrite a live update', () => {
    const merged = mergeHistory([message(2, 'live edit')], [message(1), message(2, 'stale')]);
    expect(merged.map((m) => m.text)).toEqual(['m1', 'live edit']);
  });

  it('groups reactions', () => {
    const groups = reactionGroups(
      {
        ...message(1),
        reactions: [
          { userId: 'me', emoji: '👍' },
          { userId: 'x', emoji: '👍' },
        ],
      },
      'me',
    );
    expect(groups).toEqual([{ emoji: '👍', count: 2, mine: true }]);
  });
});

describe('library, API tools and reports', () => {
  const folder = (id: string, parent: string | null) => ({
    id,
    name: id,
    color: '',
    folderParentId: parent,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
  });

  it('builds folder paths and survives cycles', () => {
    const folders = [folder('a', null), folder('b', 'a'), folder('c', 'b')];
    expect(folderPath(folders, 'c').map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(folderTree(folders, 'b').map((f) => f.id)).toEqual(['a']);
    expect(folderPath([folder('x', 'y'), folder('y', 'x')], 'x')).toHaveLength(2);
  });

  it('names colours', () => {
    expect([
      colorName(255, 0, 0),
      colorName(0, 0, 255),
      colorName(250, 250, 250),
      colorName(120, 70, 20),
    ]).toEqual(['red', 'blue', 'white', 'brown']);
  });

  it('builds headers and classifies responses', () => {
    const rows = [
      { id: '1', key: 'X-A', value: '1', enabled: true },
      { id: '2', key: 'X-B', value: '2', enabled: false },
    ];
    expect(buildHeaders(rows, 'json')).toEqual({ 'X-A': '1', 'Content-Type': 'application/json' });
    expect(bodyKind('image/svg+xml', 10)).toBe('text');
    expect(bodyKind('application/problem+json; charset=utf-8', 5)).toBe('json');
    expect(base64Bytes('aGk=')).toEqual(new Uint8Array([104, 105]));
  });

  it('escapes CSV and neutralises spreadsheet formulas', () => {
    expect(toCsv([['a,b', '=SUM(A1)', 'say "x"', -5]])).toBe(`"a,b",'=SUM(A1),"say ""x""",-5`);
  });
});
