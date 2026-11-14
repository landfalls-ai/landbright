import { describe, expect, it } from 'vitest';
import { CreateApplication, UpdateApplication } from '../src/applications';

const app = { name: 'Landfall (local)', redirectUris: ['http://localhost:3001/o/acme/auth/sso/callback'] };

describe('applications', () => {
  it('sends the secret in a header unless it asks for form fields', () => {
    expect(CreateApplication.parse(app).tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(
      CreateApplication.parse({ ...app, tokenEndpointAuthMethod: 'client_secret_post' }).tokenEndpointAuthMethod,
    ).toBe('client_secret_post');
    // private_key_jwt is an agent's, set with it; none would make it a public client.
    expect(CreateApplication.safeParse({ ...app, tokenEndpointAuthMethod: 'private_key_jwt' }).success).toBe(false);
    expect(CreateApplication.safeParse({ ...app, tokenEndpointAuthMethod: 'none' }).success).toBe(false);
  });

  it('leaves the method alone on an update that doesn’t name it', () => {
    expect(UpdateApplication.parse({ name: 'Landfall' }).tokenEndpointAuthMethod).toBeUndefined();
  });
});
