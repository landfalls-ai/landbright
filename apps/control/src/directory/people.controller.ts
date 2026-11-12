import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { CreatePersonDto, InviteResultDto, PeopleListDto, PersonDto, UpdatePersonDto } from './directory.dto';
import { PeopleService } from './people.service';

@ApiTags('People')
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @ZodResponse({ type: PeopleListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.people.list() };
  }

  @Post()
  @ApiOperation({ summary: 'Add a person; by default, email them an invite to set a password.' })
  @ZodResponse({ status: 201, type: PersonDto })
  create(@Body() body: CreatePersonDto, @Actor() actor: Principal) {
    return this.people.create(body, actor);
  }

  @Get(':id')
  @ZodResponse({ type: PersonDto })
  get(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.people.get(id);
  }

  @Patch(':id')
  @ZodResponse({ type: PersonDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdatePersonDto, @Actor() actor: Principal) {
    return this.people.update(id, body, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Block sign-in, revoke every session and token, and suspend the agents they sponsor.' })
  @ZodResponse({ type: PersonDto })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.people.deactivate(id, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @ZodResponse({ type: PersonDto })
  reactivate(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.people.reactivate(id, actor);
  }

  @Post(':id/reset-second-step')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove their authenticator app (a lost phone); they set up a new one at their next sign-in.',
  })
  @ZodResponse({ type: PersonDto })
  resetSecondStep(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.people.resetSecondStep(id, actor);
  }

  @Post(':id/invite')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a new one-time link to set a password; earlier links stop working.' })
  @ZodResponse({ type: InviteResultDto })
  invite(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.people.invite(id, actor);
  }
}
