import { useEffect } from 'react';
import { Outlet, useSearchParams } from 'react-router';
import { Loader2, LogIn, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, signIn, signOut, useMe } from '@/lib/api';
import { Sidebar } from './sidebar';

/**
 * The console is for Landbright's administrators. Without a session it sends the browser to sign in at the identity
 * plane (control's /api/auth/login), and comes back to the same page.
 */
export function AppShell() {
  const me = useMe();
  const [params] = useSearchParams();
  const failed = params.get('signin');
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (unauthenticated && !failed) signIn();
  }, [unauthenticated, failed]);

  if (me.data?.admin) {
    return (
      <div className="flex min-h-screen flex-col md:flex-row">
        <Sidebar me={me.data} />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    );
  }
  if (me.data) {
    return (
      <Gate
        icon={<ShieldX className="size-5" strokeWidth={1.7} />}
        title="The console is for administrators"
        hint={`You’re signed in as ${me.data.email}, who isn’t in Landbright Admins. Ask an administrator to add you.`}
        action={<Button onClick={() => void signOut()}>Sign out</Button>}
      />
    );
  }
  if (unauthenticated && failed) {
    return (
      <Gate
        icon={<LogIn className="size-5" strokeWidth={1.7} />}
        title={failed === 'expired' ? 'That sign-in expired' : 'Sign-in didn’t finish'}
        hint="Sign in again to open the console."
        action={
          <Button variant="primary" onClick={() => signIn('/')}>
            Sign in
          </Button>
        }
      />
    );
  }
  if (me.isError && !unauthenticated) {
    return (
      <Gate
        title="Can’t reach the control API"
        hint={
          <>
            The console sends <code className="font-mono text-[12px]">/api</code> to control on 127.0.0.1:4401. Start it
            with <code className="font-mono text-[12px]">pnpm serve</code>, and the infrastructure with{' '}
            <code className="font-mono text-[12px]">pnpm dev:up</code>.
          </>
        }
        action={<Button onClick={() => void me.refetch()}>Try again</Button>}
      />
    );
  }
  return <Gate icon={<Loader2 className="size-5 animate-spin" />} title="Signing you in…" />;
}

function Gate({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg p-6" data-testid="gate">
      <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
        <span className="mb-2 grid size-[34px] place-items-center rounded-[9px] border border-acbd bg-ac2 text-[12px] font-bold text-on-ac">
          LB
        </span>
        {icon && <div className="text-t3">{icon}</div>}
        <h1 className="text-[17px] font-semibold text-t1">{title}</h1>
        {hint && <div className="text-[13px] leading-snug text-t2">{hint}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
