import { ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AuditEvent } from '@landbright/contracts';
import { formatTime, ListState } from '@/components/directory/bits';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Cell, Row, Table } from '@/components/ui/table';
import { useAudit } from '@/lib/api';

/** "identity.deactivated" → "Identity deactivated". */
const sentence = (action: string) => {
  const s = action.replace(/[._]/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function details(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

/** Every change, newest first. Each page is checked: events must link up and match their hashes. */
export function AuditLogPage() {
  const audit = useAudit();
  const pages = audit.data?.pages ?? [];
  const events: AuditEvent[] = pages.flatMap((p) => p.items);
  const intact = pages.every((p) => p.chainIntact);
  return (
    <>
      <PageHeader
        title="Audit log"
        meta={
          audit.data &&
          (intact ? (
            <Badge tone="success" title="Every event shown links to the one before and matches its hash">
              <ShieldCheck className="size-3" /> Chain intact
            </Badge>
          ) : (
            <Badge
              tone="danger"
              title="An event shown doesn’t match its hash or link: the log was changed outside Landbright"
            >
              <ShieldAlert className="size-3" /> Chain broken
            </Badge>
          ))
        }
      />
      <PageBody className="flex max-w-[1180px] flex-col gap-3">
        {events.length ? (
          <>
            <Table head={['When', 'Who', 'What', 'Details']}>
              {events.map((e) => (
                <Row key={e.id} testId={`event-${e.action}`}>
                  <Cell className="whitespace-nowrap font-mono text-[12px] text-t3">{formatTime(e.at)}</Cell>
                  <Cell className="whitespace-nowrap text-t1">{e.actorLabel}</Cell>
                  <Cell>
                    <div className="text-t1">{sentence(e.action)}</div>
                    <Chip mono className="mt-0.5">
                      {e.action}
                    </Chip>
                  </Cell>
                  <Cell className="max-w-[420px] text-[12px] text-t2">
                    <div className="truncate" title={details(e.data)}>
                      {details(e.data) || '—'}
                    </div>
                    <div className="truncate font-mono text-[11px] text-t3" title={`hash ${e.hash}`}>
                      #{e.id} · {e.hash.slice(0, 12)}
                    </div>
                  </Cell>
                </Row>
              ))}
            </Table>
            {audit.hasNextPage && (
              <Button
                className="self-center"
                size="sm"
                onClick={() => void audit.fetchNextPage()}
                loading={audit.isFetchingNextPage}
              >
                Older events
              </Button>
            )}
          </>
        ) : (
          <ListState
            loading={audit.isLoading}
            error={audit.error}
            icon={<ScrollText className="size-5" strokeWidth={1.7} />}
            empty="Nothing yet"
          />
        )}
      </PageBody>
    </>
  );
}
