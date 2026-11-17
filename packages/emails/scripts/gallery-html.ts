/** Writes the component gallery to .preview/gallery.html (gitignored) for opening in a browser. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import Gallery from '../emails/gallery';
import { htmlBytes, renderHtml } from '../src';

const out = fileURLToPath(new URL('../../../.preview/gallery.html', import.meta.url));
mkdirSync(fileURLToPath(new URL('../../../.preview/', import.meta.url)), { recursive: true });
const html = await renderHtml(createElement(Gallery));
writeFileSync(out, html);
console.log(`wrote ${out} (${(htmlBytes(html) / 1024).toFixed(1)} KB)`);
