/** @jsxRuntime automatic @jsxImportSource react */
import { Body, Head, Html, Preview } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import { color, font, MAX_WIDTH } from '../tokens';

/** Legacy HTML attributes (bgcolor, valign…) that React's types don't declare; passed through as-is. */
export const attrs = (a: Record<string, string>) => a as Record<string, string>;

/** role=presentation table with zeroed spacing; children are <tr> elements. */
export function Table({
  children,
  style,
  width = '100%',
  bg,
}: {
  children: ReactNode;
  style?: CSSProperties;
  width?: string | number;
  bg?: string;
}) {
  return (
    <table
      role="presentation"
      width={width}
      cellPadding={0}
      cellSpacing={0}
      border={0}
      style={{ borderCollapse: 'collapse', ...(bg ? { backgroundColor: bg } : {}), ...style }}
      {...(bg ? attrs({ bgcolor: bg }) : {})}
    >
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * Dark mode: we ask for light rendering (color-scheme meta). Gmail iOS ignores it and inverts
 * colors, which turns white header text dark on the navy band; the screen/difference blend
 * wrappers (see OnNavy) keep it white there. Other clients ignore these classes.
 */
const HEAD_CSS = `
:root { color-scheme: light only; supported-color-schemes: light; }
u + .body .gm-screen { background: #000; mix-blend-mode: screen; }
u + .body .gm-diff { background: #000; mix-blend-mode: difference; }
@media only screen and (max-width: 600px) {
  .px { padding-left: 14px !important; padding-right: 14px !important; }
  .hide-sm { display: none !important; }
  .kpi { padding: 8px !important; }
  .kpi-v { font-size: 16px !important; }
  .kpi-l { font-size: 9px !important; }
}
`;

/** Outer frame: page background, 640px white card, hidden inbox preview text. */
export function EmailShell({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
        <style>{HEAD_CSS}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body
        className="body"
        style={{
          margin: 0,
          padding: '24px 0',
          backgroundColor: color.page,
          fontFamily: font,
          color: color.text,
          WebkitTextSizeAdjust: '100%',
        }}
      >
        <Table bg={color.page}>
          <tr>
            <td align="center" style={{ padding: '0 8px' }}>
              <Table
                width={MAX_WIDTH}
                bg={color.card}
                style={{
                  maxWidth: MAX_WIDTH,
                  width: '100%',
                  borderRadius: 12,
                  overflow: 'hidden',
                  border: `1px solid ${color.border}`,
                  borderCollapse: 'separate',
                }}
              >
                {children}
              </Table>
            </td>
          </tr>
        </Table>
      </Body>
    </Html>
  );
}

/** White text on the navy band that survives Gmail iOS dark-mode inversion. */
export function OnNavy({ children }: { children: ReactNode }) {
  return (
    <span className="gm-screen" style={{ display: 'inline-block' }}>
      <span className="gm-diff" style={{ display: 'inline-block', color: color.headerText }}>
        {children}
      </span>
    </span>
  );
}

/** A titled content block (one card row). */
export function Section({
  title,
  emoji,
  note,
  children,
}: {
  title: string;
  emoji?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <tr>
      <td className="px" style={{ padding: '20px 24px 6px' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10, color: color.text }}>
          {emoji ? `${emoji} ` : ''}
          {title}
          {note ? (
            <span style={{ fontSize: 12, fontWeight: 400, color: color.muted }}> · {note}</span>
          ) : null}
        </div>
        {children}
      </td>
    </tr>
  );
}

/** Gray info box, or the blue-bordered "Plan" box. */
export function Box({
  children,
  variant = 'gray',
  accent = color.review,
  style,
}: {
  children: ReactNode;
  variant?: 'gray' | 'plan';
  accent?: string;
  style?: CSSProperties;
}) {
  const bg = variant === 'plan' ? color.planBg : color.panel;
  return (
    <Table bg={bg} style={{ borderRadius: variant === 'plan' ? '0 8px 8px 0' : 8, ...style }}>
      <tr>
        <td
          style={{
            padding: '9px 12px',
            fontSize: 13,
            lineHeight: '1.5',
            color: variant === 'plan' ? color.text : color.muted,
            ...(variant === 'plan' ? { borderLeft: `4px solid ${accent}` } : {}),
          }}
        >
          {children}
        </td>
      </tr>
    </Table>
  );
}

/** Small muted line (notes under a section). */
export function Note({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 12, color: color.muted, marginTop: 8, lineHeight: '1.5', ...style }}>
      {children}
    </div>
  );
}
