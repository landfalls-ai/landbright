import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Application } from '@landbright/contracts';
import { createZodDto } from 'nestjs-zod';
import { ApplicationsService } from '../applications/applications.service';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { AgentsService } from './agents.service';
import {
  AgentDto,
  AgentListDto,
  CreateAgentApplicationDto,
  CreateAgentDto,
  ReplaceAgentKeysDto,
  UpdateAgentDto,
} from './directory.dto';

class AgentApplicationDto extends createZodDto(Application) {}

@ApiTags('Agents')
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly applications: ApplicationsService,
  ) {}

  /** The agent's own application: private_key_jwt with its public keys, bound to it (spec 005, slice 3). */
  @Post(':id/application')
  @ZodResponse({ status: 201, type: AgentApplicationDto })
  createApplication(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateAgentApplicationDto,
    @Actor() actor: Principal,
  ) {
    return this.applications.createForAgent(id, body as never, actor);
  }

  @Put(':id/application/keys')
  @ZodResponse({ type: AgentApplicationDto })
  replaceKeys(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReplaceAgentKeysDto, @Actor() actor: Principal) {
    return this.applications.replaceAgentKeys(id, body.jwks, actor);
  }

  @Get()
  @ZodResponse({ type: AgentListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.agents.list() };
  }

  @Post()
  @ZodResponse({ status: 201, type: AgentDto })
  create(@Body() body: CreateAgentDto, @Actor() actor: Principal) {
    return this.agents.create(body, actor);
  }

  @Get(':id')
  @ZodResponse({ type: AgentDto })
  get(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.agents.get(id);
  }

  @Patch(':id')
  @ZodResponse({ type: AgentDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateAgentDto, @Actor() actor: Principal) {
    return this.agents.update(id, body, actor);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @ZodResponse({ type: AgentDto })
  suspend(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.agents.setStatus(id, 'suspended', actor);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ZodResponse({ type: AgentDto })
  resume(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.agents.setStatus(id, 'active', actor);
  }
}
