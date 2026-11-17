/** @jsxRuntime automatic @jsxImportSource react */
/**
 * HEALTH email preview for `pnpm email:preview`. Uses .preview/health-props.json when
 * `pnpm collect health-email --html .preview/health.html` has written it; otherwise the sample.
 */
import { HealthEmail, type HealthEmailProps } from '../src';
import sample from '../preview/health-sample.json';
import { loadPreviewProps } from '../preview/load';

export default function Health(props: HealthEmailProps) {
  return <HealthEmail {...props} />;
}

Health.PreviewProps = loadPreviewProps<HealthEmailProps>(
  'health',
  sample as unknown as HealthEmailProps,
);
