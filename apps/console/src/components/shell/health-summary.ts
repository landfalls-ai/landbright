import type { HealthReport } from '@landbright/contracts';
import type { DotStatus } from '@/components/ui/badge';

/** One line for the sidebar and Home: how the stack is, counting control itself (it answered) as up. */
export function healthSummary(report: HealthReport | undefined, failed: boolean): { status: DotStatus; label: string } {
  if (failed) return { status: 'down', label: 'Control unreachable' };
  if (!report) return { status: 'unknown', label: 'Checking…' };
  const down = report.components.filter((c) => c.status === 'down').length;
  if (down === 0) return { status: 'up', label: 'All systems up' };
  return {
    status: report.status === 'down' ? 'down' : 'pending',
    label: `${down} of ${report.components.length + 1} down`,
  };
}
