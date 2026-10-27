import cloudApi from '../../../cloud/worker/src/index';

export async function onRequest(context: { request: Request; env: unknown }): Promise<Response> {
  // Keep the browser API same-origin so the UI does not need cross-origin
  // credentials or permissive CORS. Cloudflare Access must protect this site
  // and inject its signed assertion before this handler is reachable.
  return cloudApi.fetch(context.request, context.env as never);
}
