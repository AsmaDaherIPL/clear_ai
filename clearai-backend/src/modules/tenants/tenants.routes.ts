// Owner: BatchPlumber agent.
// Admin endpoints for tenant CRUD. v0 scope:
//   GET    /tenants                  list active tenants
//   GET    /tenants/:slug            single tenant + mapping summary
//   POST   /tenants/:slug/refresh    invalidate registry cache
// Tenant editing UI is out of scope; rows are seeded via scripts initially.

export {};
