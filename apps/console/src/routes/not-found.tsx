import { Link } from 'react-router';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { EmptyState } from '@/components/ui/empty-state';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Not found" />
      <PageBody>
        <EmptyState
          title="There’s no page here."
          action={
            <Link
              to="/"
              className="inline-flex h-7 items-center rounded-full border border-bd px-[11px] text-[12px] font-semibold text-t1 transition-colors duration-[120ms] hover:border-ac hover:text-ac"
            >
              Go home
            </Link>
          }
        />
      </PageBody>
    </>
  );
}
