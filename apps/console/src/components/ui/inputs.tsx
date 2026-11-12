import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Form fields, as Landflow's components/ui/inputs.tsx. */
const field =
  'w-full rounded-[10px] border border-hair bg-wl px-3 text-[13px] text-t1 placeholder:text-t3 outline-none transition-colors duration-[120ms] focus:border-ac disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(field, 'h-9', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(field, 'resize-y py-2 leading-relaxed', className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(field, 'h-9 appearance-none pr-8', className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-t3" />
    </div>
  );
});

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-[120ms] disabled:opacity-50',
        checked ? 'border-ac2 bg-ac2' : 'border-bd bg-wl',
      )}
    >
      <span
        className={cn(
          'size-3.5 rounded-full shadow-sm transition-transform duration-[120ms]',
          checked ? 'translate-x-[18px] bg-on-ac' : 'translate-x-[2px] bg-t3',
        )}
      />
    </button>
  );
}

/** A labelled field: the label wraps the control, with an optional hint under it. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex flex-col', className)}>
      <span className="mb-[5px] text-[12px] font-semibold text-t2">{label}</span>
      {children}
      {hint && <span className="mt-1 text-[12px] leading-snug text-t3">{hint}</span>}
    </label>
  );
}

/** A row of checkboxes as pills: pick any number of options. */
export function PickMany<T extends string>({
  options,
  value,
  onChange,
  empty,
}: {
  options: Array<{ value: T; label: string }>;
  value: T[];
  onChange: (value: T[]) => void;
  empty?: ReactNode;
}) {
  if (!options.length) return <p className="text-[12px] text-t3">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors duration-[120ms]',
              on ? 'border-acbd bg-acdim font-semibold text-ac' : 'border-hair text-t2 hover:border-bd hover:text-t1',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
