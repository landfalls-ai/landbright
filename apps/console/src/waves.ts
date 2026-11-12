/** The waves of docs/plan.md §9, each with its first slice. docs/roadmap.md is the source; keep the two in step. */
export const WAVES: Array<{ wave: number; name: string; slice: string }> = [
  {
    wave: 0,
    name: 'Foundations',
    slice: 'The services, this console and the local stack come up; the health page shows each dependency.',
  },
  {
    wave: 1,
    name: 'Identity core and sign-in',
    slice: 'A person created here signs into Landflow over OIDC and lands with the role their group maps to.',
  },
  {
    wave: 2,
    name: 'Provisioning out',
    slice: 'Deactivating a person signs them out of Landflow within seconds (SCIM).',
  },
  {
    wave: 3,
    name: 'Landflow plugins and HR lifecycle',
    slice: 'A signed HiBob “employee.joined” creates the person and adds their birthright groups.',
  },
  {
    wave: 4,
    name: 'Just-in-time access',
    slice: 'Editor on a Landflow project for 2 hours: requested, approved in Slack, granted, removed at expiry.',
  },
  {
    wave: 5,
    name: 'Agentic identity',
    slice: 'A Landflow agent asks for 15 minutes of read access; its sponsor approves; the token names both.',
  },
  {
    wave: 6,
    name: 'Policy, reviews, signals',
    slice: 'A sev1 Landfall incident gives the on-call responder the incident bundle until the room closes.',
  },
];
