import { useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, RotateCw, ShieldCheck } from 'lucide-react';
import { RotationResult, Settings } from '@landbright/contracts';
import { Fact, formatDate, formatTime } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { send, useSettings, useWrite } from '@/lib/api';

const METHOD = { password: 'Password', totp: 'Authenticator app (TOTP)', passkey: 'Passkey' } as const;

/** The tenant, how people sign in, and the keys tokens are signed with. */
export function SettingsPage() {
  const settings = useSettings();
  const update = useWrite((mfaRequired: boolean) => send('PATCH', '/api/settings/sign-in', { mfaRequired }, Settings));
  const rotate = useWrite(() => send('POST', '/api/settings/signing-keys/rotate', undefined, RotationResult));
  const [confirmRotate, setConfirmRotate] = useState(false);
  const s = settings.data;
  const waitUntil = s?.rotateAfter && new Date(s.rotateAfter) > new Date() ? s.rotateAfter : null;
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
                    After their password, people enter a code from an authenticator app or use a passkey; a passkey
                    alone counts as both steps. Anyone without either sets one up at their next sign-in. When this is
                    off, people are offered it and can say not now.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
                Methods:
                {s.signIn.methods.map((m) => (
                  <Chip key={m}>{METHOD[m]}</Chip>
                ))}
                {!s.signIn.methods.includes('passkey') && (
                  <span>· passkeys need the identity plane on a domain, not an IP address</span>
                )}
              </div>
            </Card>

            <Card className="flex flex-col gap-3">
              <div className="flex items-center">
                <SectionLabel>Signing keys</SectionLabel>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={Boolean(waitUntil)}
                  title={
                    waitUntil ? `The previous key still verifies tokens until ${formatTime(waitUntil)}` : undefined
                  }
                  onClick={() => setConfirmRotate(true)}
                >
                  <RotateCw className="size-3.5" /> Rotate
                </Button>
              </div>
              <ul className="flex flex-col gap-2">
                {s.signingKeys
                  .filter((k) => k.status !== 'retired')
                  .map((k) => (
                    <li key={k.kid} className="flex items-center gap-2.5 text-[13px]">
                      <KeyRound className="size-4 text-t3" />
                      <code className="font-mono text-[12px] text-t1">{k.kid}</code>
                      <Chip mono>{k.alg}</Chip>
                      <span className="text-t3">created {formatDate(k.createdAt)}</span>
                      {k.status === 'signing' ? (
                        <Badge tone="success" className="ml-auto">
                          <ShieldCheck className="size-3" /> Signing
                        </Badge>
                      ) : (
                        <Badge tone="muted" className="ml-auto">
                          Verifying
                        </Badge>
                      )}
                    </li>
                  ))}
              </ul>
              <p className="text-[12px] leading-snug text-t3">
                Both keys are published at <code className="font-mono">{s.issuer}/jwks</code>; the newest signs. A
                rotation adds a key that signs from then on and keeps the one it replaces, so ID tokens it signed still
                verify; it retires the key before that. Rotate again once the replaced key&rsquo;s tokens have expired
                {waitUntil ? <>, after {formatTime(waitUntil)}</> : null} (ID tokens live{' '}
                {Math.round(s.idTokenTtlSeconds / 60)} minutes). Private halves are sealed in the database under{' '}
                <code className="font-mono">LANDBRIGHT_SECRET_KEY</code>.
                {s.signingKeys.some((k) => k.status === 'retired') &&
                  ` ${s.signingKeys.filter((k) => k.status === 'retired').length} retired.`}
              </p>
            </Card>
            {confirmRotate && (
              <ConfirmDialog
                title="Rotate the signing keys?"
                action="Rotate"
                busy={rotate.isPending}
                message={
                  <>
                    <p>
                      A new key signs ID tokens from now on. The current key stays published, so tokens it signed keep
                      working until they expire; any older key is retired.
                    </p>
                    <p className="mt-2">
                      Applications pick up the new key from the issuer&rsquo;s JWKS when they meet it. Nobody is signed
                      out.
                    </p>
                  </>
                }
                onClose={() => setConfirmRotate(false)}
                onConfirm={() =>
                  rotate.mutate(undefined, {
                    onSuccess: (r) => {
                      setConfirmRotate(false);
                      toast.success(`Rotated: ${r.kid} signs now`);
                    },
                    onError: (e) => {
                      setConfirmRotate(false);
                      toast.error(e.message);
                    },
                  })
                }
              />
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
