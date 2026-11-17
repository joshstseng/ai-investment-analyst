/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Morning email preview for `pnpm email:preview`. Uses .preview/morning-props.json when
 * `pnpm collect morning --html .preview/morning.html` has written it; otherwise the sample.
 */
import { MorningEmail, type MorningEmailProps } from '../src';
import sample from '../preview/morning-sample.json';
import { loadPreviewProps } from '../preview/load';

export default function Morning(props: MorningEmailProps) {
  return <MorningEmail {...props} />;
}

Morning.PreviewProps = loadPreviewProps<MorningEmailProps>(
  'morning',
  sample as unknown as MorningEmailProps,
);
