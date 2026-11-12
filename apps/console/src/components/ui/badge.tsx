import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'muted';

const tones: Record<Tone, string> = {
  neutral: 'bg-nudim text-t2 border-transparent',
  accent: 'bg-acdim text-ac border-acbd',
  success: 'bg-gndim text-gn border-gnbd',
  warning: 'bg-warndim text-warn border-warnbd',
  danger: 'bg-rddim text-rd border-rdbd',
  muted: 'bg-transparent text-t3 border-hair',
};

/** Rounded-rect badge (statuses, counts). */
export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-[5px] whitespace-nowrap rounded-md border px-2 py-px text-[11px] font-semibold',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Pill chip (metadata, filters). */
export function Chip({
  children,
  tone = 'muted',
  className,
  mono,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-px text-[12px]',
        tones[tone],
        tone === 'muted' && 'text-t2',
        mono && 'font-mono text-[11px]',
        className,
      )}
    >
      {children}
    </span>
  );
}

export type DotStatus = 'up' | 'down' | 'pending' | 'unknown';
const DOT: Record<DotStatus, string> = { up: 'bg-gn', down: 'bg-rd', pending: 'bg-warn', unknown: 'bg-t3' };

export function StatusDot({
  status,
  pulse,
  className,
  label,
}: {
  status: DotStatus;
  pulse?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT[status], pulse && 'animate-pulse-soft', className)}
    />
  );
}
