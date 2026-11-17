/** @jsxRuntime automatic @jsxImportSource react */
import { describe, expect, it } from 'vitest';
import Gallery from '../emails/gallery';
import { RangeBar } from './components/RangeBar';
import { money, signedMoney, signedPct, toneColor } from './format';
import { EmailTooLargeError, htmlBytes, renderHtml } from './render';
import { color, MAX_HTML_BYTES } from './tokens';
import { EmailShell } from './components/layout';

describe('format', () => {
  it('uses a real minus sign and signs gains', () => {
    expect(money(-1234.4, 0)).toBe('−$1,234');
    expect(money(2345.67)).toBe('$2,345.67');
    expect(signedMoney(200)).toBe('+$200');
    expect(signedMoney(-992.4)).toBe('−$992');
    expect(signedPct(2.94)).toBe('+2.9%');
    expect(signedPct(-0.04)).toBe('0.0%');
    expect(signedPct(-11.35)).toBe('−11.3%');
  });

  it('colors gains green, losses red, zero muted', () => {
    expect(toneColor(0.3)).toBe(color.gain);
    expect(toneColor(-0.3)).toBe(color.loss);
    expect(toneColor(0)).toBe(color.muted);
    expect(toneColor(null)).toBe(color.muted);
  });
});

describe('email-safe HTML', async () => {
  const html = await renderHtml(<Gallery />);

  it('has the hidden preview text, light color scheme and no images, SVG or external CSS', () => {
    expect(html).toContain('ETFX 17.5% off high · BKX new low · ACMX Q3 8-K');
    expect(html).toContain('name="color-scheme" content="light only"');
    expect(html).not.toMatch(/<img|<svg|<link[^>]+stylesheet|<script/i);
  });

  it('uses table layout with a 640px card and bgcolor fallbacks for the navy band', () => {
    expect(html).toMatch(/width="640"/);
    expect(html).toContain('bgcolor="#0f1b2d"');
    expect(html).not.toMatch(/display:\s*(flex|grid)/);
  });

  it('stays under the Gmail clipping guard', () => {
    expect(htmlBytes(html)).toBeLessThan(MAX_HTML_BYTES);
  });

  it('refuses to render an email that Gmail would clip', async () => {
    const huge = (
      <EmailShell preview="x">
        <tr>
          <td>{'x'.repeat(MAX_HTML_BYTES)}</td>
        </tr>
      </EmailShell>
    );
    await expect(renderHtml(huge)).rejects.toThrow(EmailTooLargeError);
  });
});

describe('RangeBar', () => {
  it('clamps the marker and drops empty segments', async () => {
    const at = async (markerPct: number) =>
      renderHtml(
        <EmailShell preview="x">
          <tr>
            <td>
              <RangeBar left="stop $10" right="high $20" markerPct={markerPct} />
            </td>
          </tr>
        </EmailShell>,
      );
    expect(await at(-20)).not.toContain('width="0%"');
    expect(await at(140)).not.toContain('width="140%"');
    expect(await at(37.4)).toContain('width="37%"');
  });
});
