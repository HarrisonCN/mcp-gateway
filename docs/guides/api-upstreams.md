# GraphQL and gRPC upstreams (6.1)

Expose GraphQL operations and unary gRPC methods as tools — no MCP server needed in front of them.

```yaml
features:
  apiUpstreams:
    - id: shop
      kind: graphql
      url: https://shop.example/graphql
      headers: {authorization: "Bearer ${SHOP_TOKEN}"}
      timeoutMs: 15000
      operations:
        - name: product
          description: Look up a product
          document: "query product($id: ID!, $locale: String) { product(id: $id) { id title price } }"
    - id: billing
      kind: grpc
      url: https://billing.example # Connect server, Envoy gRPC-JSON transcoder or gRPC-Gateway
      methods:
        - name: getInvoice
          service: billing.v1.Invoices
          method: Get
          inputSchema: {type: object, properties: {id: {type: string}}, required: [id]}
```

## GraphQL

Each operation becomes the tool `<upstream>.<name>`. The input schema is derived from the variable definitions:
`ID` / `String` → string, `Int` → integer, `Float` → number, `Boolean` → boolean, `[T]` → array, `!` → required
(unless a default is given); input object types are passed through as-is. A response with `errors` is an error
(`code: graphql`), with the partial `data` in `details`.

## gRPC

Unary calls use the [Connect protocol](https://connectrpc.com/docs/protocol) with JSON bodies:
`POST <url>/<package.Service>/<Method>`, header `connect-protocol-version: 1`. The same request works against
gRPC-JSON transcoders. A non-2xx response carrying a Connect error (`{ code, message, details }`) maps to the error
`code`. Streaming methods and binary protobuf are not supported in 6.1.

## API

- `GET /api/v1/admin/api-upstreams` — upstreams and their tools with input schemas.
- `POST /api/v1/admin/api-upstreams/call` — `{ tool, arguments }`; 200 on success, 502 on an upstream error, 404 for
  an unknown tool.

The section hot reloads like other feature sections.
