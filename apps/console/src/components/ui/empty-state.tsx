import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon,
  title,
  hint,
  action,
  compact,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center text-center text-t2',
        compact ? 'gap-1 p-4' : 'gap-2 px-4 py-10',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 grid size-10 place-items-center rounded-xl border border-hair bg-sf2 text-t2">{icon}</div>
      )}
      <p className={cn('font-semibold text-t1', compact ? 'text-[13px]' : 'text-[15px]')}>{title}</p>
      {hint && <div className="max-w-[52ch] text-[13px] leading-snug">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
