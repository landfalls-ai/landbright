import {
  AddMember,
  Agent,
  AgentList,
  CreateAgent,
  CreateGroup,
  CreatePerson,
  GroupDetail,
  GroupList,
  InviteResult,
  PeopleList,
  ServiceAddMember,
  SetRequiredActions,
  Person,
  UpdateAgent,
  UpdatePerson,
} from '@landbright/contracts';
import { createZodDto } from 'nestjs-zod';

export class PersonDto extends createZodDto(Person) {}
export class PeopleListDto extends createZodDto(PeopleList) {}
export class CreatePersonDto extends createZodDto(CreatePerson) {}
export class UpdatePersonDto extends createZodDto(UpdatePerson) {}
export class InviteResultDto extends createZodDto(InviteResult) {}
export class AgentDto extends createZodDto(Agent) {}
export class AgentListDto extends createZodDto(AgentList) {}
export class CreateAgentDto extends createZodDto(CreateAgent) {}
export class UpdateAgentDto extends createZodDto(UpdateAgent) {}
export class GroupDetailDto extends createZodDto(GroupDetail) {}
export class GroupListDto extends createZodDto(GroupList) {}
export class CreateGroupDto extends createZodDto(CreateGroup) {}
export class UpdateGroupDto extends createZodDto(CreateGroup.partial()) {}
export class AddMemberDto extends createZodDto(AddMember) {}
export class SetRequiredActionsDto extends createZodDto(SetRequiredActions) {}
export class ServiceAddMemberDto extends createZodDto(ServiceAddMember) {}
