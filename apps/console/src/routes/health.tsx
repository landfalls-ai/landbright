import { useEffect, useState } from 'react';
import { RefreshCw, Unplug } from 'lucide-react';
import type { ComponentHealth } from '@landbright/contracts';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { healthSummary } from '@/components/shell/health-summary';
import { Chip, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useHealth } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';

const KIND_LABEL: Record<ComponentHealth['kind'], string> = {
  service: 'service',
  database: 'database',
  cache: 'cache',
  secrets: 'secrets',
  mail: 'mail',
};

/** Ticks once a second so "checked 3 s ago" stays true between refreshes. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Every dependency of the stack, probed by control every 5 seconds (GET /api/health). */
export function HealthPage() {
  const health = useHealth();
  const now = useNow();
  const report = health.data;
  const summary = healthSummary(report, health.isError);

  return (
    <>
      <PageHeader
        title="Health"
        meta={report && !health.isError ? <span>Checked {timeAgo(report.checkedAt, now)} · every 5 s</span> : undefined}
        actions={
          <Button size="sm" onClick={() => void health.refetch()} loading={health.isFetching} aria-label="Check now">
            {!health.isFetching && <RefreshCw className="size-3.5" />}
            Check now
          </Button>
        }
      />
      <PageBody className="flex max-w-[1080px] flex-col gap-4">
        {health.isError ? (
          <Card>
            <EmptyState
              icon={<Unplug className="size-5" strokeWidth={1.7} />}
              title="Can’t reach the control API"
              hint={
                <>
                  The console sends <code className="font-mono text-[12px]">/api</code> to control on 127.0.0.1:4401.
                  Start it with <code className="font-mono text-[12px]">pnpm serve</code>, and the infrastructure with{' '}
                  <code className="font-mono text-[12px]">pnpm dev:up</code>.
                </>
              }
            />
          </Card>
        ) : (
          <>
            <Card className="flex items-center gap-3 animate-fade-up">
              <StatusDot status={summary.status} className="size-3" />
              <div className="min-w-0">
                <div className="text-[17px] font-semibold text-t1" data-testid="health-summary">
                  {summary.label}
                </div>
                {report && (
                  <div className="text-[12px] text-t3">
                    landbright-control {report.version} · environment {report.environment}
                  </div>
                )}
              </div>
            </Card>

            <Card className="overflow-hidden p-0">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="h-10 border-b border-hair text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
                    <th className="w-8 pl-4" aria-label="Status" />
                    <th className="font-semibold">Component</th>
                    <th className="hidden font-semibold sm:table-cell">Address</th>
                    <th className="font-semibold">Detail</th>
                    <th className="pr-4 text-right font-semibold">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {report && (
                    <Row
                      component={{
                        id: 'control',
                        name: 'Control API',
                        kind: 'service',
                        status: 'up',
                        latencyMs: 0,
                        target: '127.0.0.1 via /api',
                        detail: `landbright-control ${report.version}`,
                      }}
                      latency="—"
                    />
                  )}
                  {report?.components.map((c) => (
                    <Row key={c.id} component={c} latency={`${c.latencyMs.toFixed(1)} ms`} />
                  ))}
                  {!report && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-t3">
                        Checking…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
            <p className="text-[12px] text-t3">
              Each service answers liveness at <code className="font-mono">/healthz</code>. The control API is described
              at{' '}
              <a className="underline decoration-hair underline-offset-2 hover:text-t1" href="/api/docs">
                /api/docs
              </a>{' '}
              (<code className="font-mono">/api/openapi.json</code>).
            </p>
          </>
        )}
      </PageBody>
    </>
  );
}

function Row({ component: c, latency }: { component: ComponentHealth; latency: string }) {
  return (
    <tr className="h-11 border-b border-hair last:border-0" data-testid={`component-${c.id}`}>
      <td className="pl-4">
        <StatusDot status={c.status} label={c.status} />
      </td>
      <td>
        <div className="flex items-center gap-2">
          <span className="font-medium text-t1">{c.name}</span>
          <Chip className="hidden md:inline-flex">{KIND_LABEL[c.kind]}</Chip>
        </div>
      </td>
      <td className="hidden font-mono text-[12px] text-t2 sm:table-cell">{c.target}</td>
      <td
        className={cn('max-w-[28ch] truncate', c.status === 'down' ? 'font-medium text-rd' : 'text-t2')}
        title={c.detail}
      >
        {c.detail ?? '—'}
      </td>
      <td className="pr-4 text-right font-mono text-[12px] tabular-nums text-t3">{latency}</td>
    </tr>
  );
}
