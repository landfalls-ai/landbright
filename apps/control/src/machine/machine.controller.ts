import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  AccessRequestDto,
  AnnotationDto,
  AttachWaitDto,
  DeactivateDto,
  GrantListDto,
  CreateSubscriptionDto,
  PutAnnotationDto,
  RelayDecisionDto,
  RelayTicketListDto,
  ReportTargetDto,
  ServiceCreateRequestDto,
  SubscriptionDto,
  SubscriptionListDto,
} from '../access/access.dto';
import { AccessService } from '../access/access.service';
import { Service, type ServicePrincipal } from '../common/principal';
import { PeopleService } from '../directory/people.service';
import { GroupsService } from '../directory/groups.service';
import {
  GroupDetailDto,
  GroupListDto,
  PersonDto,
  ServiceAddMemberDto,
  SetRequiredActionsDto,
} from '../directory/directory.dto';
import { EVENT_TYPES, EventsService } from '../events/events.service';
import { InactivePeopleDto } from './machine.dto';

const version = (ifMatch?: string) => (ifMatch ? Number(ifMatch.replace(/"/g, '')) : undefined);

/**
 * The machine API: what Landflow flows (and other applications, as themselves) call with a client-credentials access
 * token. Reads, notes, target reports and lifecycle actions; never a decision on a request.
 */
@ApiTags('Machine API')
@ApiBearerAuth('service')
@Controller('v1')
export class MachineController {
  constructor(
    private readonly access: AccessService,
    private readonly people: PeopleService,
    private readonly groups: GroupsService,
    private readonly events: EventsService,
  ) {}

  /**
   * Files a request: an agent's own (an agent's application may only ask for that agent), or an intake flow's for a
   * person (which then always waits for a person to decide).
   */
  @Post('requests')
  @ZodResponse({ status: 201, type: AccessRequestDto })
  file(@Body() body: ServiceCreateRequestDto, @Service('requests:create') service: ServicePrincipal) {
    return this.access.createAsService(service, body, service.agentId ?? null);
  }

  /** Tickets for the current step's approvers, to hand each of them in a chat (steps that allow relayed votes). */
  @Post('requests/:id/relay-tickets')
  @HttpCode(200)
  @ZodResponse({ type: RelayTicketListDto })
  tickets(@Param('id', ParseUUIDPipe) id: string, @Service('decisions:relay') service: ServicePrincipal) {
    return this.access.relayTickets(service, id);
  }

  /** A vote an approver cast in a chat, with the ticket that approver was given. */
  @Post('requests/:id/decisions')
  @HttpCode(200)
  @ZodResponse({ type: AccessRequestDto })
  relay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RelayDecisionDto,
    @Service('decisions:relay') service: ServicePrincipal,
  ) {
    return this.access.relayDecision(service, id, body);
  }

  @Get('requests/:id')
  @ZodResponse({ type: AccessRequestDto })
  async request(@Param('id') id: string, @Service('requests:read') service: ServicePrincipal) {
    return this.access.view(await this.access.findId(id), { service });
  }

  /** A flow's Wait: Landbright calls `resumeUrl` when the request changes. Then the flow re-reads it. */
  @Post('requests/:id/waits')
  @HttpCode(200)
  @ZodResponse({ type: AnnotationDto })
  wait(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AttachWaitDto,
    @Service('requests:read') service: ServicePrincipal,
  ) {
    return this.access.attachWait(service, id, body.resumeUrl);
  }

  @Put('requests/:id/annotations/:key')
  @ZodResponse({ type: AnnotationDto })
  annotateRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() body: PutAnnotationDto,
    @Service('annotations:write') service: ServicePrincipal,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.access.annotate(service, 'request', id, key, body.value, version(ifMatch));
  }

  @Get('grants')
  @ZodResponse({ type: GrantListDto })
  async grants(
    @Service('requests:read') _service: ServicePrincipal,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return { items: await this.access.grants({ status, type }) };
  }

  @Get('grants/:id')
  grant(@Param('id', ParseUUIDPipe) id: string, @Service('requests:read') _service: ServicePrincipal) {
    return this.access.grant(id);
  }

  @Put('grants/:id/annotations/:key')
  @ZodResponse({ type: AnnotationDto })
  annotateGrant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() body: PutAnnotationDto,
    @Service('annotations:write') service: ServicePrincipal,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.access.annotate(service, 'grant', id, key, body.value, version(ifMatch));
  }

  /** What a flow did about one target: provisioned, failed, revoked, revoke_failed, verified, drift. */
  @Post('grants/:id/targets/:key')
  @HttpCode(200)
  reportTarget(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Body() body: ReportTargetDto,
    @Service('grants:record') service: ServicePrincipal,
  ) {
    return this.access.reportTarget(service, id, key, body);
  }

  /** People who haven't signed in since a date (never-signed-in people count from when they were created). */
  @Get('people')
  @ZodResponse({ type: InactivePeopleDto })
  async inactive(
    @Service('directory:read') _service: ServicePrincipal,
    @Query('inactiveSince') inactiveSince?: string,
  ) {
    return { items: await this.people.inactiveSince(inactiveSince ? new Date(inactiveSince) : new Date()) };
  }

  /** A lifecycle flow's leaver step: everything a console deactivation does (sessions, tokens, grants, agents). */
  @Post('people/:id/deactivate')
  @HttpCode(200)
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeactivateDto,
    @Service('directory:write') service: ServicePrincipal,
  ) {
    const p = await this.people.deactivate(id, service, body.reason);
    return { id: p.id, status: p.status };
  }

  /** One person, with their department, manager and groups: what an onboarding flow decides birthright groups from. */
  @Get('people/:id')
  @ZodResponse({ type: PersonDto })
  person(@Param('id', ParseUUIDPipe) id: string, @Service('directory:read') _service: ServicePrincipal) {
    return this.people.get(id);
  }

  /** What they must do at their next sign-in, and optionally an email saying so. */
  @Post('people/:id/required-actions')
  @HttpCode(200)
  @ZodResponse({ type: PersonDto })
  requiredActions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetRequiredActionsDto,
    @Service('directory:write') service: ServicePrincipal,
  ) {
    return this.people.setRequiredActions(id, body, service);
  }

  /** Groups, or the one named `name`. */
  @Get('groups')
  @ZodResponse({ type: GroupListDto })
  async groupList(@Service('directory:read') _service: ServicePrincipal, @Query('name') name?: string) {
    return { items: await this.groups.list(name) };
  }

  /** Adds someone (source `hr`); already a member is fine. Never the administrators' group. */
  @Post('groups/:id/members')
  @HttpCode(200)
  @ZodResponse({ type: GroupDetailDto })
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ServiceAddMemberDto,
    @Service('directory:write') service: ServicePrincipal,
  ) {
    return this.groups.addMemberAsService(id, body.identityId, body.expiresAt, service);
  }

  @Delete('groups/:id/members/:identityId')
  @ZodResponse({ type: GroupDetailDto })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Service('directory:write') service: ServicePrincipal,
  ) {
    return this.groups.removeMemberAsService(id, identityId, service);
  }

  // ---------------------------------------------------------------- its own event subscriptions (events:manage)

  @Get('subscriptions')
  @ZodResponse({ type: SubscriptionListDto })
  async subscriptions(@Service('events:manage') service: ServicePrincipal) {
    return { items: await this.events.list(service.clientId), eventTypes: EVENT_TYPES };
  }

  /** Only to an origin among the application's own redirect URIs: a token can't point Landbright anywhere else. */
  @Post('subscriptions')
  @ZodResponse({ status: 201, type: SubscriptionDto })
  subscribe(@Body() body: CreateSubscriptionDto, @Service('events:manage') service: ServicePrincipal) {
    return this.events.create(body, service);
  }

  @Delete('subscriptions/:id')
  @HttpCode(204)
  unsubscribe(@Param('id', ParseUUIDPipe) id: string, @Service('events:manage') service: ServicePrincipal) {
    return this.events.remove(id, service);
  }
}
