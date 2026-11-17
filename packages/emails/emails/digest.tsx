/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Daily digest preview for `pnpm email:preview`. Uses your latest real digest when
 * `pnpm collect digest --html .preview/digest.html` has written .preview/digest-props.json
 * (gitignored); otherwise the made-up sample in preview/.
 */
import { DigestEmail, type DigestEmailProps } from '../src';
import sample from '../preview/digest-sample.json';
import { loadPreviewProps } from '../preview/load';

export default function Digest(props: DigestEmailProps) {
  return <DigestEmail {...props} />;
}

Digest.PreviewProps = loadPreviewProps<DigestEmailProps>(
  'digest',
  sample as unknown as DigestEmailProps,
);
