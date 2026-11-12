import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Actor, type Principal } from '../common/principal';
import { AddMemberDto, CreateGroupDto, GroupDetailDto, GroupListDto, UpdateGroupDto } from './directory.dto';
import { GroupsService } from './groups.service';

@ApiTags('Groups')
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  @ZodResponse({ type: GroupListDto })
  async list(@Actor() _actor: Principal) {
    return { items: await this.groups.list() };
  }

  @Post()
  @ZodResponse({ status: 201, type: GroupDetailDto })
  create(@Body() body: CreateGroupDto, @Actor() actor: Principal) {
    return this.groups.create(body, actor);
  }

  @Get(':id')
  @ZodResponse({ type: GroupDetailDto })
  get(@Param('id', ParseUUIDPipe) id: string, @Actor() _actor: Principal) {
    return this.groups.get(id);
  }

  @Patch(':id')
  @ZodResponse({ type: GroupDetailDto })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateGroupDto, @Actor() actor: Principal) {
    return this.groups.update(id, body, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return this.groups.remove(id, actor);
  }

  @Post(':id/members')
  @ZodResponse({ status: 201, type: GroupDetailDto })
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() body: AddMemberDto, @Actor() actor: Principal) {
    return this.groups.addMember(id, body.identityId, actor);
  }

  @Delete(':id/members/:identityId')
  @ZodResponse({ type: GroupDetailDto })
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Actor() actor: Principal,
  ) {
    return this.groups.removeMember(id, identityId, actor);
  }
}
