# Terraform (7.1)

Manage the servers, tenants and API keys of a gateway (in 7.x: the **control plane**) with Terraform. The gateway
exposes a REST resource API shaped for the generic
[`Mastercard/restapi`](https://registry.terraform.io/providers/Mastercard/restapi) provider, and exports the running
config as a ready-to-apply `main.tf` with `import` blocks.

Writes need `controlPlane.configApi: true`; every write validates the whole resulting config and hot-applies it, like
`PUT /api/v1/admin/config`. Changes live in the running config — make Terraform the source of truth (or also keep the
file in sync with `GET /api/v1/admin/config`).

## Adopt an existing gateway

```bash
curl -s -H "Authorization: Bearer $KEY" "https://cp.internal:4000/api/v1/admin/terraform/export" > main.tf
terraform init
TF_VAR_gateway_admin_key=$KEY terraform plan   # imports every server, tenant and named API key
```

Secrets (upstream `headers` / `env`, API `key`s) never appear in the export: each becomes a `sensitive` variable
(`var.server_github_headers_Authorization`, `var.api_key_ci_key`), and `ignore_changes_to` keeps their redacted
read-back from showing as drift.

## Resources

```hcl
resource "restapi_object" "server_github" {
  path         = "/api/v1/admin/terraform/servers"
  id_attribute = "id"
  data = jsonencode({
    id        = "github"
    name      = "GitHub"
    transport = "streamable-http"
    url       = "https://api.githubcopilot.com/mcp/"
    headers   = { Authorization = "Bearer ${var.github_token}" }
  })
  ignore_changes_to = ["headers"]
}

resource "restapi_object" "tenant_acme" {
  path         = "/api/v1/admin/terraform/tenants"
  id_attribute = "id"
  data         = jsonencode({ id = "acme", servers = ["github"] })
  depends_on   = [restapi_object.server_github]
}

resource "restapi_object" "api_key_ci" {
  path         = "/api/v1/admin/terraform/apiKeys"
  id_attribute = "name"
  data         = jsonencode({ name = "ci", key = var.ci_key, scope = { servers = ["github"] } })
  ignore_changes_to = ["key"]
}
```

| Kind | Id | Object |
|------|----|--------|
| `servers` | `id` | a `servers[]` entry (schema v7: `timeoutMs`) |
| `tenants` | `id` | a `tenants[]` entry |
| `apiKeys` | `name` | an object-form `auth.apiKeys[]` entry with a `name` (needs `auth.strategy: api-key`; unnamed keys are left alone) |

## API

| | |
|-|-|
| `GET /api/v1/admin/terraform` | kinds, paths, provider, `writable` |
| `GET /api/v1/admin/terraform/:kind` | list (secrets `<redacted>`) |
| `POST /api/v1/admin/terraform/:kind[?dryRun=true]` | create → 201 (409 if the id exists; dry run returns the config diff) |
| `GET /api/v1/admin/terraform/:kind/:id` | read, with `ETag` |
| `PUT /api/v1/admin/terraform/:kind/:id[?dryRun=true]` | replace; `If-Match` → 412 when stale; `<redacted>` keeps the current value |
| `DELETE /api/v1/admin/terraform/:kind/:id` | remove → 204 |
| `GET /api/v1/admin/terraform/export[?format=hcl\|json][&url=]` | `main.tf` (or JSON) for the running config |

An invalid result (e.g. a duplicate server id, an unknown transport) is a 400 with the validation errors, and nothing
is applied.

## Native provider

A dedicated `mcp-gateway` Terraform provider (Go, registry-published) is planned on top of this API; the resource API
and export format are what it will use, so configurations written against `restapi_object` can be moved with
`terraform state mv` / `moved` blocks.
