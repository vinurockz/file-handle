export interface HeaderRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export function buildHeaders(
  rows: HeaderRow[],
  bodyType: 'none' | 'json' | 'text',
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (row.enabled && key) headers[key] = row.value;
  }
  if (
    bodyType !== 'none' &&
    !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  ) {
    headers['Content-Type'] = bodyType === 'json' ? 'application/json' : 'text/plain';
  }
  return headers;
}

export const base64Bytes = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export type BodyKind = 'json' | 'text' | 'image' | 'video' | 'audio' | 'binary' | 'empty';

export function bodyKind(contentType: string, size: number): BodyKind {
  if (!size) return 'empty';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.includes('json')) return 'json';
  // SVG is shown as text: rendering untrusted markup is not worth the risk.
  if (
    type.startsWith('text/') ||
    type.includes('xml') ||
    type.includes('javascript') ||
    type.includes('urlencoded')
  )
    return 'text';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'binary';
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
