// Turns user-selected files into evidence for the council, entirely in the browser.
// Output items match council.js openingMessage(): {name, kind:'text', text} or {name, kind:'image', dataUrl, page?}.
// Libraries for PDF and Word files load from the CDN only when such a file is attached.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js';

export const MAX_TEXT_CHARS = 120_000; // per file, ~30k tokens
export const MAX_SCANNED_PAGES = 10;
const MAX_IMAGE_PX = 1600;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|ya?ml|log|ini|rtf|eml|srt|vtt)$/i;

export const ACCEPT =
  '.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.yaml,.yml,.log,.eml,.pdf,.docx,image/*';

function truncate(text, name) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= MAX_TEXT_CHARS) return { text: clean, truncated: false };
  return {
    text: `${clean.slice(0, MAX_TEXT_CHARS)}\n\n[… ${name} truncated: ${clean.length - MAX_TEXT_CHARS} more characters not included]`,
    truncated: true,
  };
}

async function imageToDataUrl(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ??= import(`${PDFJS}/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

let mammothPromise;
function loadMammoth() {
  mammothPromise ??= new Promise((resolve, reject) => {
    if (window.mammoth) return resolve(window.mammoth);
    const s = document.createElement('script');
    s.src = MAMMOTH;
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => reject(new Error('Could not load the Word reader'));
    document.head.append(s);
  });
  return mammothPromise;
}

async function readPdf(file) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    const text = content.items.map((i) => i.str + (i.hasEOL ? '\n' : ' ')).join('').trim();
    pages.push(text);
  }
  const chars = pages.reduce((sum, p) => sum + p.length, 0);

  // A text layer averaging under ~40 characters a page is almost certainly a scan.
  if (chars >= 40 * doc.numPages) {
    const { text, truncated } = truncate(pages.map((p, i) => `[Page ${i + 1}]\n${p}`).join('\n\n'), file.name);
    return {
      items: [{ name: file.name, kind: 'text', text }],
      note: `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}, text extracted${truncated ? ' (truncated)' : ''}`,
    };
  }

  const count = Math.min(doc.numPages, MAX_SCANNED_PAGES);
  const items = [];
  for (let n = 1; n <= count; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, MAX_IMAGE_PX / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    items.push({ name: file.name, kind: 'image', page: n, dataUrl: canvas.toDataURL('image/jpeg', 0.8) });
  }
  return {
    items,
    note:
      `scanned (no text layer) — sent as ${count} page image${count > 1 ? 's' : ''}` +
      (doc.numPages > count ? ` of ${doc.numPages}` : '') +
      '; only image-capable models can read it',
  };
}

async function readDocx(file) {
  const mammoth = await loadMammoth();
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const { text, truncated } = truncate(value, file.name);
  return { items: [{ name: file.name, kind: 'text', text }], note: `text extracted${truncated ? ' (truncated)' : ''}` };
}

/**
 * Read one File into evidence items.
 * @returns {Promise<{name:string, items:object[], note:string, chars:number, images:number}>}
 */
export async function readAttachment(file) {
  let result;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    result = await readPdf(file);
  } else if (/\.docx$/i.test(file.name)) {
    result = await readDocx(file);
  } else if (file.type.startsWith('image/')) {
    result = { items: [{ name: file.name, kind: 'image', dataUrl: await imageToDataUrl(file) }], note: 'image' };
  } else if (file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.test(file.name)) {
    const { text, truncated } = truncate(await file.text(), file.name);
    result = { items: [{ name: file.name, kind: 'text', text }], note: truncated ? 'text (truncated)' : 'text' };
  } else {
    throw new Error(`${file.name}: unsupported file type. Use PDF, Word (.docx), images or text files.`);
  }
  const chars = result.items.reduce((s, i) => s + (i.text?.length ?? 0), 0);
  if (!result.items.length || (chars === 0 && !result.items.some((i) => i.kind === 'image'))) {
    throw new Error(`${file.name}: no readable content found.`);
  }
  return { name: file.name, ...result, chars, images: result.items.filter((i) => i.kind === 'image').length };
}
