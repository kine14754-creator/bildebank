// Stand-in for the `cloudflare:workers` runtime module, which only exists inside
// workerd. @cloudflare/workers-oauth-provider imports WorkerEntrypoint from it;
// the worker's unit tests never use that class, they only need the import to load.
export class WorkerEntrypoint {}
