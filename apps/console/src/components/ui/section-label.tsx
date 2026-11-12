import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-[11px] font-semibold uppercase tracking-[0.06em] text-t3', className)}>{children}</div>
  );
}
