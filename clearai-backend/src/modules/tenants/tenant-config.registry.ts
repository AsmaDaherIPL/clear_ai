// Owner: BatchPlumber agent.
// In-memory cache of tenant configs, populated from DB at startup.
// Expected exports: resolve(slug | id) -> TenantConfig, refresh() -> void.
// IMPORTANT: this file is the ONLY place the rest of the code asks "give me tenant X".
// No other module touches the tenants table directly.

export {};
