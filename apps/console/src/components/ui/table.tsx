import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The list table every directory page uses: a card, a quiet uppercase header, 44px rows. */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto rounded-2xl border border-hair bg-sf', className)}>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="h-10 border-b border-hair text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-4 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children, onClick, testId }: { children: ReactNode; onClick?: () => void; testId?: string }) {
  return (
    <tr
      data-testid={testId}
      onClick={onClick}
      className={cn('h-11 border-b border-hair last:border-0', onClick && 'cursor-pointer hover:bg-acdim/40')}
    >
      {children}
    </tr>
  );
}

export function Cell({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('px-4 py-2 align-middle', className)}>{children}</td>;
}
