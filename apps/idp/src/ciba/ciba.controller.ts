import { Body, Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { Public } from '@landbright/platform';
import { appendAudit, PRISMA, type PrismaClient, TENANT, type TenantRef, withTenant } from '@landbright/persistence';
import type { Request, Response } from 'express';
import { errors } from 'oidc-provider';
import { type Signed, SelfSession } from '../account/self-session';
import { agentOf } from '../oidc/agents';
import type { OidcProviderRef } from '../oidc/provider-ref';
import { cibaPage } from '../pages/agent-pages';
import { messagePage } from '../pages/pages';
import { OIDC_PROVIDER } from '../valkey';

const ID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * The person's side of CIBA: the page a Landflow flow links to (`ciba.requested`). Signed in as the person the agent
 * named, they approve or deny; the agent, polling the token endpoint, then gets tokens that say it acts for them, or
 * `access_denied`. Public routes because the person signs in here (the account client); the form carries the
 * session's CSRF token.
 */
@Public()
@Controller('ciba')
export class CibaController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProviderRef,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(TENANT) private readonly tenant: TenantRef,
    private readonly session: SelfSession,
  ) {}

  @Get(':id')
  async show(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (!ID.test(id)) return this.ended(res);
    const signed = await this.session.signedIn(req, res);
    if (!signed) return this.session.signIn(res, { ciba: id });
    const found = await this.find(id, signed, res);
    if (!found) return;
    const { request, agent } = found;
    const sponsor = agent.sponsorId
      ? await withTenant(this.prisma, this.tenant.id, (tx) =>
          tx.identity.findUnique({ where: { id: agent.sponsorId }, select: { displayName: true } }),
        )
      : null;
    this.page(
      res,
      200,
      cibaPage({
        agent: agent.name,
        sponsor: sponsor?.displayName,
        scope: String(request.scope ?? '')
          .split(' ')
          .filter((s) => s && s !== 'openid'),
        bindingMessage: (request.params?.binding_message as string | undefined) ?? null,
        expiresAt: new Date((request.exp ?? 0) * 1000),
        action: `/ciba/${id}`,
        csrf: this.session.csrf(signed.sessionId),
      }),
    );
  }

  @Post(':id')
  async decide(
    @Param('id') id: string,
    @Body() body: { csrf?: string; decision?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!ID.test(id)) return this.ended(res);
    const signed = await this.session.signedIn(req, res);
    if (!signed) return this.session.signIn(res, { ciba: id });
    if (!this.session.csrfMatches(signed.sessionId, body?.csrf))
      return this.page(res, 403, messagePage('This form expired', 'Open the link again and decide there.'));
    const found = await this.find(id, signed, res);
    if (!found) return;
    const { request, agent, provider } = found;
    const approve = body?.decision === 'approve';
    if (approve) {
      const grant = new provider.Grant({ accountId: signed.self.identityId, clientId: request.clientId! });
      grant.addOIDCScope(String(request.scope ?? 'openid'));
      await grant.save();
      await provider.backchannelResult(request, grant, {
        amr: signed.amr,
        acr: signed.acr,
        authTime: signed.loginTs,
      });
    } else {
      await provider.backchannelResult(request, new errors.AccessDenied('The person denied the request.'));
    }
    await withTenant(this.prisma, this.tenant.id, (tx) =>
      appendAudit(tx, this.tenant.id, {
        actorId: signed.self.identityId,
        actorLabel: signed.self.displayName,
        action: approve ? 'ciba.approved' : 'ciba.denied',
        targetType: 'identity',
        targetId: agent.agentId,
        data: { requestId: id, clientId: request.clientId, agent: agent.name, scope: request.scope },
      }),
    );
    this.page(
      res,
      200,
      approve
        ? messagePage('Approved', `${agent.name} can now act for you. You can close this page.`)
        : messagePage('Denied', `${agent.name} was told no. You can close this page.`),
    );
  }

  /** The pending request, for the signed-in person only; otherwise the page that says why not. */
  private async find(id: string, signed: Signed, res: Response) {
    const provider = this.oidc.current;
    const request = await provider.BackchannelAuthenticationRequest.find(id);
    if (!request || request.isExpired) return void this.ended(res);
    if (request.accountId !== signed.self.identityId)
      return void this.page(
        res,
        403,
        messagePage('Not yours', 'This request is for someone else. Sign out and open the link as them.'),
      );
    if ((request as { grantId?: string }).grantId || (request as { error?: string }).error)
      return void this.page(res, 409, messagePage('Already decided', 'This request has been answered.'));
    const agent = agentOf(await provider.Client.find(request.clientId!));
    if (!agent) return void this.ended(res);
    return { request, agent, provider };
  }

  private ended(res: Response): void {
    this.page(res, 404, messagePage('This request has ended', 'Ask the agent to start again if you still need it.'));
  }

  private page(res: Response, status: number, body: string): void {
    res.status(status).type('html').setHeader('cache-control', 'no-store').send(body);
  }
}
