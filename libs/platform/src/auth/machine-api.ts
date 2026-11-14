/**
 * The machine API (/api/v1 on the control plane): what applications such as Landflow call as themselves, with an
 * access token from Landbright's own issuer (client credentials, RFC 8707 resource indicator). The identity plane
 * issues JWT access tokens for this resource; the control plane checks them against the same signing keys. The scopes
 * are in libs/contracts (`MACHINE_API_SCOPES`).
 */
export const MACHINE_API_RESOURCE = 'urn:landbright:api';
