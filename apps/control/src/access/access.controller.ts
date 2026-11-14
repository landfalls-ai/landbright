import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Actor, Person, type Principal } from '../common/principal';
import {
  AccessRequestDto,
  AccessRequestListDto,
  BundleDto,
  BundleListDto,
  CreateBundleDto,
  CreateRequestDto,
  DecideRequestDto,
  ExtendGrantDto,
  GrantListDto,
  PreviewRequestDto,
  RequestPreviewDto,
  RevokeGrantDto,
  UpdateBundleDto,
} from './access.dto';
import { AccessService } from './access.service';

/** Bundles and their policies: administrators. */
@ApiTags('Access')
@Controller('bundles')
export class BundlesController {
  constructor(private readonly access: AccessService) {}

  @Get()
  @ZodResponse({ type: BundleListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.access.listBundles() };
  }

  @Post()
  @ZodResponse({ status: 201, type: BundleDto })
  create(@Body() body: CreateBundleDto, @Actor() actor: Principal) {
    return this.access.createBundle(body, actor);
  }

  @Get(':id')
  @ZodResponse({ type: BundleDto })
  get(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.access.getBundle(id);
  }

  @Patch(':id')
  @ZodResponse({ type: BundleDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBundleDto, @Actor() actor: Principal) {
    return this.access.updateBundle(id, body, actor);
  }
}

/**
 * The access portal, for every signed-in person: ask for access (for yourself or an agent you sponsor), see your
 * requests, decide the ones the policy names you for, give access back. Administrators also see every request.
 */
@ApiTags('Access')
@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('bundles')
  @ZodResponse({ type: BundleListDto })
  async bundles(@Person() person: Principal) {
    return { items: await this.access.requestable(person) };
  }

  @Post('requests/preview')
  @HttpCode(200)
  @ZodResponse({ type: RequestPreviewDto })
  preview(@Body() body: PreviewRequestDto, @Person() person: Principal) {
    return this.access.preview(person, body);
  }

  @Post('requests')
  @ZodResponse({ status: 201, type: AccessRequestDto })
  create(@Body() body: CreateRequestDto, @Person() person: Principal) {
    return this.access.create(person, body);
  }

  @Get('requests')
  @ZodResponse({ type: AccessRequestListDto })
  async list(
    @Person() person: Principal,
    @Query('scope') scope: 'mine' | 'to-decide' | 'all' = 'mine',
    @Query('status') status?: string,
  ) {
    const s = scope === 'to-decide' || scope === 'all' ? scope : 'mine';
    return { items: await this.access.list(person, s, status) };
  }

  /** By id or by number (REQ-128): the decision link uses the number. */
  @Get('requests/:ref')
  @ZodResponse({ type: AccessRequestDto })
  async get(@Param('ref') ref: string, @Person() person: Principal) {
    return this.access.view(await this.access.findId(ref), { person });
  }

  @Post('requests/:id/decision')
  @HttpCode(200)
  @ZodResponse({ type: AccessRequestDto })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() body: DecideRequestDto, @Person() person: Principal) {
    return this.access.decide(person, id, body);
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  @ZodResponse({ type: AccessRequestDto })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Person() person: Principal) {
    return this.access.cancel(person, id);
  }

  /** Every grant (administrators): the Grants page. */
  @Get('grants')
  @ZodResponse({ type: GrantListDto })
  async grants(@Actor() _admin: Principal, @Query('status') status?: string) {
    return { items: await this.access.grants({ status }) };
  }

  /** Ask for more time on a grant you hold: a request of its own (`extends`), decided like the first. */
  @Post('grants/:id/extend')
  @ZodResponse({ status: 201, type: AccessRequestDto })
  extend(@Param('id', ParseUUIDPipe) id: string, @Body() body: ExtendGrantDto, @Person() person: Principal) {
    return this.access.extend(person, id, body);
  }

  @Post('grants/:id/revoke')
  @HttpCode(200)
  @ZodResponse({ type: AccessRequestDto })
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() body: RevokeGrantDto, @Person() person: Principal) {
    return this.access.revoke(person, id, body.comment);
  }
}
