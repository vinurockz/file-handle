/** Lazy, configured access to pdf.js. The worker and font data are served as static assets. */
import type { PDFDocumentProxy } from 'pdfjs-dist';

export type PdfJs = typeof import('pdfjs-dist');

let library: Promise<PdfJs> | null = null;

export function pdfjs(): Promise<PdfJs> {
  library ??= import('pdfjs-dist').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', document.baseURI).href;
    return lib;
  });
  return library;
}

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  const asset = (folder: string) => new URL(`pdfjs/${folder}/`, document.baseURI).href;
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  return lib.getDocument({
    data: data.slice(),
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs'),
    isEvalSupported: false,
  } as Parameters<PdfJs['getDocument']>[0]).promise;
}
