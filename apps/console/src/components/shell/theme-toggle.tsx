import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'landbright-theme';

function current(): Theme {
  const theme = document.documentElement.dataset.theme;
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

const OPTIONS: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
];

/** System, light or dark; index.html applies the saved choice before paint. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);
  return (
    <div className="flex w-fit gap-0.5 rounded-lg border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => {
            setTheme(value);
            apply(value);
          }}
          className={cn(
            'grid size-6 place-items-center rounded-md border border-transparent text-t3 transition-colors hover:text-t1',
            theme === value && 'border-bd bg-sf text-t1 shadow-[0_1px_2px_var(--hair)]',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
