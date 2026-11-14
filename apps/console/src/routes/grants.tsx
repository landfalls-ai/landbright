import { useNavigate, useSearchParams } from 'react-router';
import { KeyRound } from 'lucide-react';
import { GrantStatusBadge, relative, TargetStatusBadge } from '@/components/access/bits';
import { formatTime, ListState } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Cell, Row, Table } from '@/components/ui/table';
import { useGrants } from '@/lib/api';
import { cn } from '@/lib/utils';

const FILTERS = [
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Starting later' },
  { value: '', label: 'All' },
];

/** Who holds what, until when, and what each Landflow flow did about it. */
export function GrantsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'active';
  const grants = useGrants(status || undefined);
  const navigate = useNavigate();
  const items = grants.data?.items ?? [];
  return (
    <>
      <PageHeader title="Grants" meta={grants.data && <span>{items.length} shown</span>} />
      <PageBody className="flex max-w-[1180px] flex-col gap-3">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setParams({ status: f.value })}
              className={cn(
                'h-8 rounded-full px-3 text-[13px] transition-colors duration-[120ms]',
                status === f.value ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:text-t1',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        {items.length ? (
          <Table head={['Grant', 'Holder', 'Status', 'Until', 'What was given']}>
            {items.map((g) => (
              <Row key={g.id} onClick={() => navigate(`/access/requests/${g.ref}`)} testId={`grant-${g.ref}`}>
                <Cell>
                  <div className="font-medium text-t1">{g.bundle.name}</div>
                  <div className="font-mono text-[11px] text-t3">{g.ref}</div>
                </Cell>
                <Cell className="text-t1">{g.subject.displayName}</Cell>
                <Cell>
                  <GrantStatusBadge status={g.status} />
                </Cell>
                <Cell className="whitespace-nowrap text-[12px] text-t2">
                  {g.closedAt ? (
                    <span className="text-t3">ended {formatTime(g.closedAt)}</span>
                  ) : (
                    <>
                      {formatTime(g.expiresAt)} <span className="text-t3">({relative(g.expiresAt)})</span>
                    </>
                  )}
                </Cell>
                <Cell>
                  <div className="flex flex-col gap-1">
                    {g.targets.map((t) => (
                      <div key={t.key} className="flex items-center gap-2 text-[12px]">
                        <span className="max-w-[260px] truncate text-t2" title={t.key}>
                          {t.label}
                        </span>
                        <TargetStatusBadge status={t.status} />
                      </div>
                    ))}
                  </div>
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <ListState
            loading={grants.isLoading}
            error={grants.error}
            icon={<KeyRound className="size-5" strokeWidth={1.7} />}
            empty={status === 'active' ? 'Nobody holds anything right now' : 'No grants'}
            emptyHint="A grant starts when a request is approved and ends by itself at its time."
          />
        )}
      </PageBody>
    </>
  );
}
