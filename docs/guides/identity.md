# Enterprise SSO and SCIM (6.4)

Connect the gateway to your identity provider (Okta, Microsoft Entra ID, OneLogin, Google Workspace, Keycloak …):
users and groups are provisioned with **SCIM 2.0**, people sign in with **OIDC**, and IdP groups map to **tenant
roles**.

```yaml
identity:
  oidc:
    issuer: https://acme.okta.com
    clientId: 0oa1example
    redirectUri: https://gateway.acme.com/sso/callback
    groupsClaim: groups            # ID-token claim with group names
    # jwksUrl: …                   # default: <issuer>/.well-known/jwks.json
  groupRoles:
    - { group: Platform, tenant: platform, role: owner }
    - { group: Engineering, tenant: eng, role: admin }
    - { group: Support, tenant: eng }          # viewer
  storePath: ./data/scim.json      # optional: persist the SCIM directory across restarts
```

## SCIM provisioning

Point the IdP's SCIM app at `https://<gateway>/api/v1/admin/identity/scim/v2` with an **operator API key** as the
bearer token. Supported (RFC 7643 / 7644):

- `Users` and `Groups`: `POST`, `GET` (list with `filter`, `startIndex`, `count`), `GET /:id`, `PUT`, `PATCH`,
  `DELETE`. `userName` is unique (case-insensitive; `409 uniqueness`).
- `PATCH` operations `add` / `replace` / `remove`, with or without `path` (including `name.givenName`), and group
  membership changes `members` / `members[value eq "<id>"]` — what Okta and Entra send.
- Filters: `eq`, `ne`, `co`, `sw`, `ew`, `pr`, combined with `and` / `or`.
- `ServiceProviderConfig`, `ResourceTypes`, `Schemas`; `application/scim+json` bodies; ETags in `meta.version`.

Deactivating a user (`active: false`) removes all of their memberships; deleting a user removes them from groups.

## SSO

- `GET /api/v1/admin/identity/sso/authorize-url` — an authorization-code + PKCE (S256) URL with `state` and the
  `codeVerifier` for your login front end.
- `POST /api/v1/admin/identity/sso/verify` `{ idToken }` — verifies signature, issuer, audience and expiry, then
  returns the user, their groups (ID-token claim ∪ SCIM groups), the effective tenant memberships, and the client id
  to use (`sso:<email>`). Deactivated SCIM users get `403`.

## Memberships

`GET /api/v1/admin/identity/memberships?user=ada@acme.com` resolves a provisioned user's groups through `groupRoles`.
When several groups map to the same tenant, the highest role wins (`owner` > `admin` > `viewer`).
