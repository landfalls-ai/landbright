import { useState } from 'react';
import { AppWindow, KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { type Acr, ACR_LABELS, ACR_VALUES, Application, ApplicationWithSecret } from '@landbright/contracts';
import { formatDate, ListState } from '@/components/directory/bits';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, Chip } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ConfirmDialog, Dialog, FormError } from '@/components/ui/dialog';
import { Field, Input, PickMany, Select, Textarea } from '@/components/ui/inputs';
import { SectionLabel } from '@/components/ui/section-label';
import { send, useApplications, useGroups, useWrite } from '@/lib/api';

type Grant = 'authorization_code' | 'refresh_token' | 'client_credentials';
const GRANTS: Array<{ value: Grant; label: string }> = [
  { value: 'authorization_code', label: 'Sign-in (authorization code)' },
  { value: 'refresh_token', label: 'Refresh tokens' },
  { value: 'client_credentials', label: 'Service calls (client credentials)' },
];
/** The weakest sign-in an application accepts: any, or an `acr` (people who signed in more weakly are asked again). */
function StrengthSelect({
  value,
  onChange,
  ...rest
}: {
  value: Acr | null;
  onChange: (value: Acr | null) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  return (
    <Select value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as Acr | null)} {...rest}>
      <option value="">Any sign-in</option>
      {ACR_VALUES.filter((v) => v !== 'urn:landbright:acr:pwd').map((v) => (
        <option key={v} value={v}>
          {ACR_LABELS[v]}
        </option>
      ))}
    </Select>
  );
}

const lines = (text: string) =>
  text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The applications that sign in with Landbright: OIDC clients, with their secret shown once. */
export function ApplicationsPage() {
  const apps = useApplications();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<ApplicationWithSecret>();
  const [deleting, setDeleting] = useState<Application>();
  const rotate = useWrite((id: string) =>
    send('POST', `/api/applications/${id}/rotate-secret`, undefined, ApplicationWithSecret),
  );
  const remove = useWrite((id: string) => send('DELETE', `/api/applications/${id}`));
  const strength = useWrite(({ id, minimumAcr }: { id: string; minimumAcr: Acr | null }) =>
    send('PATCH', `/api/applications/${id}`, { minimumAcr }, Application),
  );
  const items = apps.data?.items ?? [];
  const add = (
    <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
      <Plus className="size-3.5" /> Register application
    </Button>
  );
  return (
    <>
      <PageHeader
        title="Applications"
        meta={
          apps.data && (
            <span className="flex items-center gap-1">
              Issuer <code className="font-mono text-t2">{apps.data.issuer}</code>
              <CopyButton text={apps.data.issuer} label="Copy the issuer URL" />
            </span>
          )
        }
        actions={add}
      />
      <PageBody className="flex max-w-[1080px] flex-col gap-3">
        {items.length ? (
          items.map((a) => (
            <Card key={a.id} className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2" data-testid={`app-${a.clientId}`}>
                <span className="text-[14px] font-semibold text-t1">{a.name}</span>
                <Chip mono>{a.clientId}</Chip>
                {a.system && (
                  <Badge tone="muted" title="Managed by the bootstrap">
                    <Lock className="size-3" /> Landbright
                  </Badge>
                )}
                <span className="ml-auto text-[12px] text-t3">Added {formatDate(a.createdAt)}</span>
              </div>
              <div className="grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-[120px_1fr]">
                <span className="text-t3">Redirect URIs</span>
                <span className="flex flex-col font-mono text-t2">
                  {a.redirectUris.map((u) => (
                    <span key={u}>{u}</span>
                  ))}
                </span>
                <span className="text-t3">Grant types</span>
                <span className="text-t2">{a.grantTypes.join(', ')}</span>
                <span className="text-t3">Secret</span>
                <span className="text-t2">Version {a.secretVersion}</span>
                <span className="self-center text-t3">Sign-in needs</span>
                <span>
                  {a.system ? (
                    <span className="text-t2">{a.minimumAcr ? ACR_LABELS[a.minimumAcr] : 'Any sign-in'}</span>
                  ) : (
                    <StrengthSelect
                      value={a.minimumAcr}
                      aria-label={`What ${a.name} needs at sign-in`}
                      data-testid={`strength-${a.clientId}`}
                      disabled={strength.isPending}
                      onChange={(minimumAcr) =>
                        strength.mutate(
                          { id: a.id, minimumAcr },
                          {
                            onSuccess: () =>
                              toast.success(
                                minimumAcr
                                  ? `${a.name} now asks for ${ACR_LABELS[minimumAcr].toLowerCase()}.`
                                  : `${a.name} accepts any sign-in.`,
                              ),
                            onError: (e) => toast.error(e.message),
                          },
                        )
                      }
                    />
                  )}
                </span>
              </div>
              {!a.system && (
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    loading={rotate.isPending && rotate.variables === a.id}
                    onClick={() =>
                      rotate.mutate(a.id, { onSuccess: setSecret, onError: (e) => toast.error(e.message) })
                    }
                  >
                    <KeyRound className="size-3.5" /> New secret
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(a)}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>
              )}
            </Card>
          ))
        ) : (
          <ListState
            loading={apps.isLoading}
            error={apps.error}
            icon={<AppWindow className="size-5" strokeWidth={1.7} />}
            empty="No applications"
            action={add}
          />
        )}
      </PageBody>
      {adding && (
        <RegisterDialog
          onClose={() => setAdding(false)}
          onCreated={(r) => {
            setAdding(false);
            setSecret(r);
          }}
        />
      )}
      {secret && <SecretDialog result={secret} onClose={() => setSecret(undefined)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          action="Delete application"
          busy={remove.isPending}
          message="It can’t sign anyone in anymore, and every token it holds is revoked now."
          onClose={() => setDeleting(undefined)}
          onConfirm={() =>
            remove.mutate(deleting.id, {
              onSuccess: () => setDeleting(undefined),
              onError: (e) => toast.error(e.message),
            })
          }
        />
      )}
    </>
  );
}

function RegisterDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (r: ApplicationWithSecret) => void;
}) {
  const [form, setForm] = useState({ name: '', clientId: '', redirectUris: '', postLogoutRedirectUris: '' });
  const [grantTypes, setGrantTypes] = useState<Grant[]>(['authorization_code', 'refresh_token']);
  const [minimumAcr, setMinimumAcr] = useState<Acr | null>(null);
  const create = useWrite(() =>
    send(
      'POST',
      '/api/applications',
      {
        name: form.name,
        clientId: form.clientId || undefined,
        redirectUris: lines(form.redirectUris),
        postLogoutRedirectUris: lines(form.postLogoutRedirectUris),
        grantTypes,
        minimumAcr,
      },
      ApplicationWithSecret,
    ),
  );
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  return (
    <Dialog
      title="Register an application"
      subtitle="An OIDC client. You’ll see its secret once, next."
      onClose={onClose}
      width={560}
      onSubmit={() => create.mutate(undefined, { onSuccess: onCreated })}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Register
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={form.name} onChange={set('name')} required autoFocus placeholder="Landflow" />
          </Field>
          <Field label="Client id" hint="Optional; made from the name.">
            <Input value={form.clientId} onChange={set('clientId')} placeholder="landflow" className="font-mono" />
          </Field>
        </div>
        <Field
          label="Redirect URIs"
          hint={
            <>
              One per line. For Landflow:{' '}
              <code className="font-mono">http://localhost:3000/api/auth/oidc/callback</code> (its public URL).
            </>
          }
        >
          <Textarea
            rows={2}
            value={form.redirectUris}
            onChange={set('redirectUris')}
            required
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label="After sign-out, back to" hint="Optional, one per line.">
          <Textarea
            rows={1}
            value={form.postLogoutRedirectUris}
            onChange={set('postLogoutRedirectUris')}
            className="font-mono text-[12px]"
          />
        </Field>
        <div>
          <div className="mb-[5px] text-[12px] font-semibold text-t2">Grant types</div>
          <PickMany options={GRANTS} value={grantTypes} onChange={setGrantTypes} />
        </div>
        <Field
          label="Sign-in needs"
          hint="People who signed in more weakly are asked for more before they reach it (step-up)."
        >
          <StrengthSelect value={minimumAcr} onChange={setMinimumAcr} aria-label="Sign-in needs" />
        </Field>
        <FormError error={create.error} />
      </div>
    </Dialog>
  );
}

/** The secret, once, and what to paste into Landflow's environment. */
function SecretDialog({ result, onClose }: { result: ApplicationWithSecret; onClose: () => void }) {
  const groups = useGroups();
  const names = (groups.data?.items ?? []).filter((g) => !g.system).map((g) => g.name);
  const roleMap = names.length
    ? names.map((n) => `${n}=member`).join(',')
    : 'Landflow Editors=member,Landflow Admins=admin';
  const env = [
    `LANDFLOW_OIDC_ISSUER=${result.issuer}`,
    `LANDFLOW_OIDC_CLIENT_ID=${result.application.clientId}`,
    `LANDFLOW_OIDC_CLIENT_SECRET=${result.clientSecret}`,
    `LANDFLOW_OIDC_SCOPES="openid email profile roles"`,
    `LANDFLOW_OIDC_ROLE_MAP="${roleMap}"`,
    `LANDFLOW_OIDC_LABEL="Sign in with Landbright"`,
  ].join('\n');
  return (
    <Dialog
      title={`${result.application.name}: client secret`}
      subtitle="Copy it now. Landbright doesn’t keep it and can’t show it again."
      onClose={onClose}
      width={620}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-[10px] border border-hair bg-wl px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-t1" data-testid="client-secret">
            {result.clientSecret}
          </code>
          <CopyButton text={result.clientSecret} label="Copy the secret" />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center">
            <SectionLabel>For Landflow’s .env</SectionLabel>
            <CopyButton text={env} label="Copy the Landflow settings" className="ml-auto" />
          </div>
          <pre className="overflow-x-auto rounded-[10px] border border-hair bg-wl px-3 py-2 font-mono text-[11px] leading-relaxed text-t2">
            {env}
          </pre>
          <p className="text-[12px] text-t3">
            Edit the role map: each group name to <code className="font-mono">admin</code> or{' '}
            <code className="font-mono">member</code>. Landflow reads the <code className="font-mono">roles</code>{' '}
            claim, which carries the person’s group names.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
