/**
 * Puts CORS headers on @udibo/oauth2's local identity provider for the app's
 * origin, which the provider does not send (udibo/oauth2#190). Everything
 * else passes through unchanged: the provider still signs in, issues and
 * refuses.
 *
 *   node e2e/cors-proxy.mjs <listen port> <provider port> <allowed origin>
 */
import { request, createServer } from "node:http";

const [listenPort, targetPort, allowedOrigin] = process.argv.slice(2);

const corsHeaders = (origin) =>
  origin === allowedOrigin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "authorization, content-type",
        vary: "Origin",
      }
    : {};

createServer((incoming, outgoing) => {
  const origin = incoming.headers.origin;
  if (incoming.method === "OPTIONS" && incoming.headers["access-control-request-method"]) {
    outgoing.writeHead(204, corsHeaders(origin)).end();
    return;
  }
  const upstream = request(
    { host: "127.0.0.1", port: targetPort, method: incoming.method, path: incoming.url, headers: incoming.headers },
    (response) => {
      outgoing.writeHead(response.statusCode, { ...response.headers, ...corsHeaders(origin) });
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => outgoing.writeHead(502).end());
  incoming.pipe(upstream);
}).listen(Number(listenPort), "127.0.0.1", () => console.log(`CORS proxy on ${listenPort} for ${targetPort}`));
