import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Application,
  ApplicationList,
  ApplicationWithSecret,
  CreateApplication,
  UpdateApplication,
} from '@landbright/contracts';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { ApplicationsService } from './applications.service';

class ApplicationDto extends createZodDto(Application) {}
class ApplicationListDto extends createZodDto(ApplicationList) {}
class ApplicationWithSecretDto extends createZodDto(ApplicationWithSecret) {}
class CreateApplicationDto extends createZodDto(CreateApplication) {}
class UpdateApplicationDto extends createZodDto(UpdateApplication) {}

@ApiTags('Applications')
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  @ZodResponse({ type: ApplicationListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.applications.list(), issuer: this.applications.issuer };
  }

  @Post()
  @ApiOperation({ summary: 'Register an application. The response carries its client secret, once.' })
  @ZodResponse({ status: 201, type: ApplicationWithSecretDto })
  create(@Body() body: CreateApplicationDto, @Actor() actor: Principal) {
    return this.applications.create(body, actor);
  }

  @Get(':id')
  @ZodResponse({ type: ApplicationDto })
  get(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.applications.get(id);
  }

  @Patch(':id')
  @ZodResponse({ type: ApplicationDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateApplicationDto, @Actor() actor: Principal) {
    return this.applications.update(id, body, actor);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a new client secret, shown once. The old one stops working at once.' })
  @ZodResponse({ type: ApplicationWithSecretDto })
  rotate(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.applications.rotateSecret(id, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.applications.remove(id, actor);
  }
}
