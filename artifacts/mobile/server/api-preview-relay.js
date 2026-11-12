/* Development-only same-origin access to the app's existing public API host.
 * Never bundled into the native app or enabled in the production server.
 */
const https = require("node:https");
function relayPreviewApi(req, res) {
  const headers = { ...req.headers, host: "api.templetv.org.ng" };
  delete headers.origin;
  delete headers.connection;
  delete headers["proxy-authorization"];
  const upstream = https.request({
    hostname: "api.templetv.org.ng", port: 443, path: req.url,
    method: req.method, headers,
  }, response => {
    if (res.destroyed) { response.destroy(); return; }
    res.writeHead(response.statusCode || 502, response.headers);
    response.on("error", () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(45_000, () => upstream.destroy(new Error("Preview API timeout")));
  upstream.on("error", () => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end('{"error":"The Temple TV API is temporarily unavailable."}');
  });
  req.once("aborted", () => upstream.destroy());
  res.once("close", () => upstream.destroy());
  req.pipe(upstream);
}
module.exports = { relayPreviewApi };
