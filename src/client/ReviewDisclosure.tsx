import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Native disclosure keeps review details keyboard accessible after a decision. */
export function ReviewDisclosure({
  settled,
  summary,
  children,
}: {
  settled: boolean;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      className="review-disclosure"
      key={settled ? 'receipt' : 'review'}
      open={!settled}
    >
      <summary>
        {summary}
        <ChevronDown size={15} className="review-chevron" aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}
