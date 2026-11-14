import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateScimTarget,
  ReplaceScimToken,
  ScimTargetDetail,
  ScimTargetList,
  ScimTestResult,
  UpdateScimTarget,
} from '@landbright/contracts';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { ProvisioningService } from './provisioning.service';

class ScimTargetListDto extends createZodDto(ScimTargetList) {}
class ScimTargetDetailDto extends createZodDto(ScimTargetDetail) {}
class CreateScimTargetDto extends createZodDto(CreateScimTarget) {}
class UpdateScimTargetDto extends createZodDto(UpdateScimTarget) {}
class ReplaceScimTokenDto extends createZodDto(ReplaceScimToken) {}
class ScimTestResultDto extends createZodDto(ScimTestResult) {}

/** Provisioning targets (spec 006): the SCIM servers Landbright keeps in step. Administrators. */
@ApiTags('Provisioning')
@Controller('provisioning/targets')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Get()
  @ZodResponse({ type: ScimTargetListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.provisioning.list() };
  }

  @Post()
  @ZodResponse({ status: 201, type: ScimTargetDetailDto })
  create(@Body() body: CreateScimTargetDto, @Actor() actor: Principal) {
    return this.provisioning.create(body, actor);
  }

  @Get(':id')
  @ZodResponse({ type: ScimTargetDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.provisioning.get(id);
  }

  @Patch(':id')
  @ZodResponse({ type: ScimTargetDetailDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateScimTargetDto, @Actor() actor: Principal) {
    return this.provisioning.update(id, body, actor);
  }

  @Put(':id/token')
  @ZodResponse({ type: ScimTargetDetailDto })
  token(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReplaceScimTokenDto, @Actor() actor: Principal) {
    return this.provisioning.replaceToken(id, body.token, actor);
  }

  @Post(':id/sync')
  @HttpCode(200)
  @ZodResponse({ type: ScimTargetDetailDto })
  sync(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.provisioning.sync(id, actor);
  }

  @Post(':id/test')
  @HttpCode(200)
  @ZodResponse({ type: ScimTestResultDto })
  test(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.provisioning.test(id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.provisioning.remove(id, actor);
  }
}
