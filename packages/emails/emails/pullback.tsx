/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Pullback alert preview for `pnpm email:preview`. Uses .preview/pullback-props.json when
 * `pnpm collect pullback-preview --symbols X --html .preview/pullback.html` has written it.
 */
import { PullbackEmail, type PullbackEmailProps } from '../src';
import sample from '../preview/pullback-sample.json';
import { loadPreviewProps } from '../preview/load';

export default function Pullback(props: PullbackEmailProps) {
  return <PullbackEmail {...props} />;
}

Pullback.PreviewProps = loadPreviewProps<PullbackEmailProps>(
  'pullback',
  sample as unknown as PullbackEmailProps,
);
