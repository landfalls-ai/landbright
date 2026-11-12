import { toast } from 'sonner';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Settings } from '@landbright/contracts';
import { Fact, formatDate } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { Switch } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { send, useSettings, useWrite } from '@/lib/api';

const METHOD = { password: 'Password', totp: 'Authenticator app (TOTP)', passkey: 'Passkey' } as const;

/** The tenant, how people sign in, and the keys tokens are signed with. */
export function SettingsPage() {
  const settings = useSettings();
  const update = useWrite((mfaRequired: boolean) => send('PATCH', '/api/settings/sign-in', { mfaRequired }, Settings));
  const s = settings.data;
  return (
    <>
      <PageHeader title="Settings" />
      <PageBody className="flex max-w-[860px] flex-col gap-4">
        {!s ? (
          <Card>
            <p className="py-8 text-center text-[13px] text-t3">
              {settings.error instanceof Error ? settings.error.message : 'Loading…'}
            </p>
          </Card>
        ) : (
          <>
            <Card className="flex flex-col gap-3">
              <SectionLabel>Tenant</SectionLabel>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Fact label="Name">{s.tenant.name}</Fact>
                <Fact label="Slug">
                  <code className="font-mono text-[12px]">{s.tenant.slug}</code>
                </Fact>
                <Fact label="Issuer">
                  <span className="flex items-center gap-1">
                    <code className="truncate font-mono text-[12px]">{s.issuer}</code>
                    <CopyButton text={s.issuer} label="Copy the issuer URL" />
                  </span>
                </Fact>
              </dl>
            </Card>

            <Card className="flex flex-col gap-3">
              <SectionLabel>Sign-in</SectionLabel>
              <div className="flex items-start gap-3">
                <Switch
                  checked={s.signIn.mfaRequired}
                  disabled={update.isPending}
                  label="Require a second step"
                  onChange={(on) =>
                    update.mutate(on, {
                      onSuccess: () =>
                        toast.success(on ? 'A second step is now required' : 'The second step is optional now'),
                      onError: (e) => toast.error(e.message),
                    })
                  }
                />
                <div className="text-[13px]">
                  <div className="font-semibold text-t1">Require a second step for everyone</div>
                  <p className="mt-0.5 leading-snug text-t2">
                    After their password, people enter a code from an authenticator app. Anyone without one sets it up
                    at their next sign-in. When this is off, people are offered it and can say not now.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
                Methods:
                {s.signIn.methods.map((m) => (
                  <Chip key={m}>{METHOD[m]}</Chip>
                ))}
                <span>· passkeys come next</span>
              </div>
            </Card>

            <Card className="flex flex-col gap-3">
              <SectionLabel>Signing keys</SectionLabel>
              <ul className="flex flex-col gap-2">
                {s.signingKeys.map((k) => (
                  <li key={k.kid} className="flex items-center gap-2.5 text-[13px]">
                    <KeyRound className="size-4 text-t3" />
                    <code className="font-mono text-[12px] text-t1">{k.kid}</code>
                    <Chip mono>{k.alg}</Chip>
                    <span className="text-t3">created {formatDate(k.createdAt)}</span>
                    {k.retiredAt ? (
                      <Badge tone="muted" className="ml-auto">
                        Retired
                      </Badge>
                    ) : (
                      <Badge tone="success" className="ml-auto">
                        <ShieldCheck className="size-3" /> Signing
                      </Badge>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-[12px] text-t3">
                Published at <code className="font-mono">{s.issuer}/jwks</code>. The private half is sealed in the
                database under <code className="font-mono">LANDBRIGHT_SECRET_KEY</code>. Rotation comes later in wave 1.
              </p>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}
