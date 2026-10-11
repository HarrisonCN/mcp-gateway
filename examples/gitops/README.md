# GitOps example (14.7)

A config repository for two environments, `staging` and `prod`, applied by CI as signed, approved releases.

```
config/
  base.yml                     # shared; includes servers.yml and policy.yml
  servers.yml
  policy.yml
  environments/
    staging.yml                # 1 approval, extra scratch server
    prod.yml                   # 2 approvals, control plane, canary rollout
    _prod-policy.yml           # partial included by prod.yml
workflow.yml                   # GitHub Actions: plan on PRs, sign on main, apply approved releases
```

```bash
mcp-gateway gitops render -d config -e prod                 # the bundle CI would apply
mcp-gateway gitops diff   -d config -e staging --against-env prod
mcp-gateway gitops plan   -d config -e prod --url https://gw.internal:4000 --key $OP_KEY
mcp-gateway gitops keygen --out ~/.mcp-gateway/alice       # once per approver; publish the .pub in trustedKeys
mcp-gateway gitops approve release-prod.json --key ~/.mcp-gateway/alice.key --key-id alice --by alice
```

The public keys in `environments/*.yml` are examples — replace them with your own (`mcp-gateway gitops keygen`).
Secrets stay references (`${GITHUB_TOKEN}`); `render` refuses a literal. See [docs/guides/gitops.md](../../docs/guides/gitops.md).
