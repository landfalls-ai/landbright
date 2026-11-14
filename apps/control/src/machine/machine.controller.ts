import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  AccessRequestDto,
  AnnotationDto,
  AttachWaitDto,
  DeactivateDto,
  GrantListDto,
  PutAnnotationDto,
  ReportTargetDto,
} from '../access/access.dto';
import { AccessService } from '../access/access.service';
import { Service, type ServicePrincipal } from '../common/principal';
import { PeopleService } from '../directory/people.service';
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
  ) {}

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
}
