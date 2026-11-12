import { PageBody, PageHeader, Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import type { NavItem } from '@/nav';

/** A page whose wave hasn't shipped: what it will do, and when. */
export function UpcomingPage({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <>
      <PageHeader title={item.label} meta={<Badge tone="muted">Wave {item.wave}</Badge>} />
      <PageBody className="max-w-[1080px]">
        <Card className="animate-fade-up">
          <EmptyState
            icon={<Icon className="size-5" strokeWidth={1.7} />}
            title={`${item.label} arrives in wave ${item.wave}`}
            hint={item.summary}
          />
        </Card>
      </PageBody>
    </>
  );
}
