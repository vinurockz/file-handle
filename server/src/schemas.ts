import { z } from 'zod';

const text = (max = 500) => z.string().max(max);
const title = (fallback: string) =>
  z
    .string()
    .trim()
    .max(200)
    .default(fallback)
    .transform((v) => v || fallback);
const color = (fallback: string) => z.string().max(40).default(fallback);
const ref = z.string().max(64).nullable().default(null);
/** Nested editor structures are owned by the client; the server only checks they are objects. */
const objects = (max = 5000) => z.array(z.record(z.string(), z.unknown())).max(max).default([]);
const object = z.record(z.string(), z.unknown()).default({});
const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const headerRows = z
  .array(z.object({ id: text(64), key: text(200), value: text(4000), enabled: z.boolean() }))
  .max(100)
  .default([]);

const noteLikeBlocks = objects(500);

const movie = z.object({
  title: title('Untitled movie'),
  aspect: z.enum(['16:9', '9:16', '1:1', '4:3']).default('16:9'),
  background: color('#000000'),
  clips: objects(500),
  header: object,
  footer: object,
  musicMediaId: ref,
  musicVolume: z.number().min(0).max(2).default(0.5),
});

const project = z.object({
  name: title('Untitled project'),
  mediaId: ref,
  doc: object,
  /** "done" once the current version has been saved to the library. */
  status: z.enum(['draft', 'done']).default('draft'),
});

export interface CollectionRule {
  schema: z.ZodType<Record<string, unknown>>;
  /** Collection a document's parentId must belong to. */
  parent?: string;
}

export const COLLECTIONS: Record<string, CollectionRule> = {
  folders: {
    schema: z.object({ name: title('New folder'), color: color(''), folderParentId: ref }),
  },
  notes: {
    schema: z.object({
      title: text(300).default(''),
      color: color('#ffffff'),
      pinned: z.boolean().default(false),
      archived: z.boolean().default(false),
      labels: z.array(text(40)).max(30).default([]),
      blocks: noteLikeBlocks,
    }),
  },
  bills: {
    schema: z.object({
      docType: z.enum(['bill', 'quotation']).default('bill'),
      date: text(20).default(''),
      billNo: text(40).default(''),
      companyLogoMediaId: ref,
      companyName: text(200).default(''),
      companyTagline: text(200).default(''),
      companyAddress: text(600).default(''),
      companyPhone: text(100).default(''),
      recipientName: text(200).default(''),
      recipientAddress: text(600).default(''),
      salutation: text(100).default('Dear Sir,'),
      introText: text(2000).default(
        'We are pleased to submit the following for your consideration.',
      ),
      items: objects(300),
      currency: text(8).default('₹'),
      taxPercent: z.number().min(0).max(100).default(0),
      discount: z.number().min(0).max(1e12).default(0),
      signOffText: text(300).default('Thanking you,\nYours faithfully,'),
      signerName: text(200).default(''),
      signatureMediaId: ref,
      footerText: text(1000).default(''),
    }),
  },
  books: {
    schema: z.object({
      title: title('Untitled book'),
      coverColor: color('#4f46e5'),
      pageLimit: z.number().int().min(1).max(1000).nullable().default(null),
    }),
  },
  bookPages: {
    parent: 'books',
    schema: z.object({ background: color('#ffffff'), elements: objects(300) }),
  },
  taskSections: {
    schema: z.object({ title: title('New section'), color: color('#6366f1') }),
  },
  tasks: {
    parent: 'taskSections',
    schema: z.object({
      title: title('Untitled task'),
      blocks: noteLikeBlocks,
      completed: z.boolean().default(false),
      priority: z.enum(['low', 'medium', 'high']).default('medium'),
      dueDate: text(20).default(''),
    }),
  },
  textChats: {
    schema: z.object({ name: title('Untitled conversation'), messages: objects(20000) }),
  },
  movies: { schema: movie },
  slideshows: { schema: movie },
  sites: {
    schema: z.object({
      name: title('My website'),
      themeColor: color('#4f46e5'),
      fontFamily: text(200).default('system-ui, sans-serif'),
      textColor: color('#0f172a'),
      backgroundColor: color('#ffffff'),
      faviconMediaId: ref,
    }),
  },
  sitePages: {
    parent: 'sites',
    schema: z.object({
      title: title('Page'),
      slug: z
        .string()
        .max(80)
        .regex(/^[a-z0-9-]*$/, 'Use lowercase letters, numbers and dashes')
        .default(''),
      seoDescription: text(500).default(''),
      blocks: objects(500),
    }),
  },
  pdfProjects: { schema: project },
  imageProjects: { schema: project },
  videoProjects: { schema: project },
  customEndpoints: {
    schema: z.object({
      name: title('Untitled endpoint'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      path: z
        .string()
        .trim()
        .max(200)
        .regex(/^[a-zA-Z0-9_\-.]+(\/[a-zA-Z0-9_\-.]+)*$/, 'Use a path like users/list')
        .refine(
          (value) => !value.split('/').some((s) => s === '.' || s === '..'),
          'Dot segments are not allowed',
        ),
      enabled: z.boolean().default(true),
      statusCode: z.number().int().min(200).max(599).default(200),
      contentType: z
        .enum(['application/json', 'text/plain', 'text/html'])
        .default('application/json'),
      body: text(200_000).default('{\n  "ok": true\n}'),
      delayMs: z.number().int().min(0).max(10_000).default(0),
    }),
  },
  apiRequests: {
    schema: z.object({
      name: text(200).default(''),
      saved: z.boolean().default(false),
      method: method.default('GET'),
      url: text(4000).default(''),
      headers: headerRows,
      bodyType: z.enum(['none', 'json', 'text']).default('none'),
      body: text(500_000).default(''),
    }),
  },
};
