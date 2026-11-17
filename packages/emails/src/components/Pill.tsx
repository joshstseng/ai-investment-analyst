/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from 'react';
import { color, SEVERITY, type Severity } from '../tokens';

export type PillTone =
  'neutral' | 'navy' | 'escalated' | 'gain' | 'loss' | Exclude<Severity, 'info'>;

const TONES: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: color.pillBg, fg: color.muted },
  navy: { bg: color.navy, fg: '#ffffff' },
  escalated: { bg: '#fde8e8', fg: '#b91c1c' },
  gain: { bg: '#e7f6ec', fg: '#15803d' },
  loss: { bg: '#fde8e8', fg: '#b91c1c' },
  action: { bg: SEVERITY.action.color, fg: '#ffffff' },
  warning: { bg: SEVERITY.warning.color, fg: '#ffffff' },
  review: { bg: SEVERITY.review.color, fg: '#ffffff' },
  reminder: { bg: SEVERITY.reminder.color, fg: '#ffffff' },
  health: { bg: SEVERITY.health.color, fg: '#ffffff' },
};

/** Rounded label: rule status (confirmed/draft/placeholder), escalation, severity, or a ticker chip (navy). */
export function Pill({
  children,
  tone = 'neutral',
  size = 'sm',
}: {
  children: ReactNode;
  tone?: PillTone;
  size?: 'xs' | 'sm' | 'md';
}) {
  const t = TONES[tone];
  const fontSize = size === 'xs' ? 10 : size === 'sm' ? 11 : 12;
  const chip = tone === 'navy';
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize,
        lineHeight: '1.3',
        fontWeight: chip || size === 'md' ? 700 : 400,
        backgroundColor: t.bg,
        color: t.fg,
        borderRadius: chip ? 6 : 10,
        padding: size === 'md' ? '3px 10px' : size === 'xs' ? '1px 5px' : '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Severity pill with emoji, e.g. "📝 REVIEW". */
export function SeverityPill({ severity }: { severity: Severity }) {
  const s = SEVERITY[severity];
  return (
    <Pill tone={severity === 'info' ? 'neutral' : severity} size="md">
      {s.emoji} {s.label}
    </Pill>
  );
}
