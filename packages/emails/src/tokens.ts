/** Design tokens for every AIA email (see docs/email-mockup.html, kept locally). */
export const color = {
  page: '#e9edf3',
  card: '#ffffff',
  navy: '#0f1b2d',
  navyTile: '#1a2a44',
  headerKicker: '#8fa6c7',
  headerText: '#ffffff',
  headerSub: '#b9c7dc',
  text: '#1a2233',
  body: '#3d475a',
  muted: '#5b6577',
  faint: '#8a93a3',
  border: '#d5dbe5',
  line: '#e3e8f0',
  rowLine: '#f0f3f7',
  panel: '#f6f8fb',
  pillBg: '#eef2f8',
  planBg: '#eef4ff',
  rangeFill: '#93b4f5',
  gain: '#16a34a',
  loss: '#dc2626',
  lossOnNavy: '#ff6b6b',
  lossSubOnNavy: '#ff9a9a',
  gainOnNavy: '#4ade80',
  warning: '#d97706',
  review: '#2563eb',
  action: '#dc2626',
  reminder: '#7c3aed',
  health: '#0f766e',
} as const;

export const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const MAX_WIDTH = 640;

/** Gmail clips messages over ~102 KB; stay well under. */
export const MAX_HTML_BYTES = 90_000;

export type Severity = 'action' | 'warning' | 'review' | 'reminder' | 'health' | 'info';

export const SEVERITY: Record<Severity, { color: string; emoji: string; label: string }> = {
  action: { color: color.action, emoji: '‼️', label: 'ACTION' },
  warning: { color: color.warning, emoji: '⚠️', label: 'WARNING' },
  review: { color: color.review, emoji: '📝', label: 'REVIEW' },
  reminder: { color: color.reminder, emoji: '💡', label: 'REMINDER' },
  health: { color: color.health, emoji: '🩺', label: 'HEALTH' },
  info: { color: color.muted, emoji: 'ℹ️', label: 'INFO' },
};
