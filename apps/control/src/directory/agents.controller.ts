import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { AgentsService } from './agents.service';
import { AgentDto, AgentListDto, CreateAgentDto, UpdateAgentDto } from './directory.dto';

@ApiTags('Agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

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
