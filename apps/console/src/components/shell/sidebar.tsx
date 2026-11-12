import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { HeartPulse, Menu, X } from 'lucide-react';
import { CURRENT_WAVE, NAV_GROUPS, type NavItem, SETTINGS } from '@/nav';
import { useHealth } from '@/lib/api';
import { cn } from '@/lib/utils';
import { StatusDot } from '../ui/badge';
import { healthSummary } from './health-summary';
import { ThemeToggle } from './theme-toggle';

/**
 * The left rail, after Landflow's components/shell/sidebar.tsx: product mark, environment, grouped navigation, the
 * stack's health, theme. On a phone (below `md`) it is a drawer behind a slim top bar.
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const [openOn, setOpenOn] = useState<string>();
  const open = openOn === pathname;
  return (
    <>
      <PhoneBar onMenu={() => setOpenOn(pathname)} />
      {open && (
        <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setOpenOn(undefined)} aria-hidden />
      )}
      <Rail open={open} onClose={() => setOpenOn(undefined)} />
    </>
  );
}

function Mark({ size }: { size: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center border border-acbd bg-ac2 font-bold tracking-[0.02em] text-on-ac',
        size === 'md' ? 'size-[34px] rounded-[9px] text-[12px]' : 'size-7 rounded-[8px] text-[11px]',
      )}
    >
      LB
    </span>
  );
}

function PhoneBar({ onMenu }: { onMenu: () => void }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hair bg-sf2 px-2 md:hidden">
      <button
        type="button"
        aria-label="Open the menu"
        onClick={onMenu}
        className="grid size-9 place-items-center rounded-lg text-t2 hover:bg-acdim hover:text-t1"
      >
        <Menu className="size-[18px]" strokeWidth={1.7} />
      </button>
      <Link to="/" className="flex items-center gap-2">
        <Mark size="sm" />
        <span className="text-[13px] font-semibold text-t1">Landbright</span>
      </Link>
    </div>
  );
}

function NavRow({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.href}
      end={item.href === '/'}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms]',
          isActive ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
        )
      }
    >
      <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
      <span className="truncate">{item.label}</span>
      {item.wave > CURRENT_WAVE && (
        <span className="ml-auto font-mono text-[10px] font-normal text-t3" title={`Arrives in wave ${item.wave}`}>
          w{item.wave}
        </span>
      )}
    </NavLink>
  );
}

function Rail({ open, onClose }: { open: boolean; onClose: () => void }) {
  const health = useHealth();
  const summary = healthSummary(health.data, health.isError);
  const environment = health.data?.environment;
  return (
    <aside
      className={cn(
        'top-0 h-screen w-[196px] shrink-0 flex-col border-r border-hair bg-sf2 px-1.5 py-2.5 md:sticky md:z-30 md:flex md:overflow-y-auto md:shadow-none',
        open ? 'fixed left-0 z-50 flex overflow-y-auto shadow-pop' : 'hidden',
      )}
    >
      <button
        type="button"
        aria-label="Close the menu"
        onClick={onClose}
        className="absolute right-1.5 top-2.5 grid size-8 place-items-center rounded-lg text-t3 hover:bg-acdim hover:text-t1 md:hidden"
      >
        <X className="size-4" />
      </button>
      <Link to="/" className="mb-2 flex items-center gap-2.5 px-2.5 py-1">
        <Mark size="md" />
        <span className="truncate text-[13px] font-semibold text-t1">Landbright</span>
      </Link>
      {environment && (
        <span
          title={`Environment: ${environment}`}
          className="mx-2.5 mb-1 flex items-center rounded-md border border-acbd bg-acdim px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ac"
          data-testid="environment-badge"
        >
          <span className="truncate">{environment}</span>
        </span>
      )}

      <nav className="flex flex-col" aria-label="Main">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              {group.label}
            </div>
            {group.items.map((item) => (
              <NavRow key={item.href} item={item} />
            ))}
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-0.5 pt-3">
        <NavLink
          to="/health"
          className={({ isActive }) =>
            cn(
              'flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms]',
              isActive ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
            )
          }
        >
          <HeartPulse className="size-[18px] shrink-0" strokeWidth={1.7} />
          <span className="truncate">Health</span>
          <StatusDot status={summary.status} className="ml-auto" label={summary.label} />
        </NavLink>
        <NavRow item={SETTINGS} />
      </div>
      <div className="flex flex-col gap-2.5 px-2.5 pb-1 pt-2">
        <div className="flex items-center gap-2 text-[12px] text-t3" data-testid="health-line">
          <StatusDot status={summary.status} pulse={summary.status === 'unknown'} />
          {summary.label}
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
