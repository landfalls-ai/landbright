import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { healthSummary } from '@/components/shell/health-summary';
import { Badge, StatusDot } from '@/components/ui/badge';
import { SectionLabel } from '@/components/ui/section-label';
import { useHealth } from '@/lib/api';
import { CURRENT_WAVE } from '@/nav';
import { cn } from '@/lib/utils';
import { WAVES } from '@/waves';

/** Home answers "what needs me?" (plan §6.2). Until there are people and requests, it shows the stack and the road. */
export function HomePage() {
  const health = useHealth();
  const summary = healthSummary(health.data, health.isError);
  return (
    <>
      <PageHeader title="Home" />
      <PageBody className="flex max-w-[1080px] flex-col gap-5">
        <div className="animate-fade-up">
          <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-t1">Nothing needs you yet.</h2>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-t2">
            Landbright is at wave {CURRENT_WAVE}, the foundations. The identity and control services, this console and
            the local stack are running. People, agents and sign-in come in wave 1. After that, this page lists the
            requests waiting for you, grants that end today, joiners and leavers, and agents without a sponsor.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <Card className="flex flex-col gap-3 p-0">
            <div className="flex h-11 items-center justify-between border-b border-hair px-4">
              <SectionLabel>System</SectionLabel>
              <Link
                to="/health"
                className="flex items-center gap-1 text-[12px] text-t3 transition-colors duration-[120ms] hover:text-t1"
              >
                Health <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="flex items-center gap-2.5 px-4">
              <StatusDot status={summary.status} className="size-2.5" />
              <span className="text-[15px] font-semibold text-t1">{summary.label}</span>
            </div>
            <ul className="flex flex-col pb-2">
              {(health.data?.components ?? []).map((c) => (
                <li key={c.id} className="flex h-8 items-center gap-2.5 px-4 text-[13px]">
                  <StatusDot status={c.status} />
                  <span className="text-t1">{c.name}</span>
                  <span className="ml-auto truncate font-mono text-[11px] text-t3">
                    {c.status === 'up' ? c.detail : 'down'}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-0">
            <div className="flex h-11 items-center border-b border-hair px-4">
              <SectionLabel>The road</SectionLabel>
            </div>
            <ol className="flex flex-col py-1">
              {WAVES.map((w) => (
                <li key={w.wave} className={cn('flex gap-3 px-4 py-2', w.wave === CURRENT_WAVE && 'bg-acdim')}>
                  <span className="w-5 shrink-0 pt-px font-mono text-[12px] text-t3">{w.wave}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-t1">{w.name}</span>
                      {w.wave === CURRENT_WAVE && <Badge tone="accent">Now</Badge>}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-snug text-t2">{w.slice}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
