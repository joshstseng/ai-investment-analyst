import { render } from '@react-email/components';
import type { ReactElement } from 'react';
import { MAX_HTML_BYTES } from './tokens';

export class EmailTooLargeError extends Error {}

/**
 * Renders an email element to HTML; throws EmailTooLargeError if Gmail would clip it, unless
 * `guard` is false (last-resort sends, after a trimmed version was still too large).
 */
export async function renderHtml(
  element: ReactElement,
  opts: { guard?: boolean } = {},
): Promise<string> {
  const html = await render(element);
  const bytes = htmlBytes(html);
  if (opts.guard !== false && bytes > MAX_HTML_BYTES) {
    throw new EmailTooLargeError(`email HTML is ${bytes} bytes (limit ${MAX_HTML_BYTES})`);
  }
  return html;
}

export function htmlBytes(html: string): number {
  return Buffer.byteLength(html, 'utf8');
}
