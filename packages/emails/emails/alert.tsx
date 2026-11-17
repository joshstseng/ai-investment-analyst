/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Rule alert preview for `pnpm email:preview`. Uses a real alert when
 * `pnpm collect alert --ticker T --html .preview/alert.html` has written .preview/alert-props.json
 * (gitignored); otherwise the made-up sample in preview/.
 */
import { AlertEmail, type AlertEmailProps } from '../src';
import sample from '../preview/alert-sample.json';
import { loadPreviewProps } from '../preview/load';

export default function Alert(props: AlertEmailProps) {
  return <AlertEmail {...props} />;
}

Alert.PreviewProps = loadPreviewProps<AlertEmailProps>(
  'alert',
  sample as unknown as AlertEmailProps,
);
