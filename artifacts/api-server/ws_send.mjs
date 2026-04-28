import WebSocket from "ws";

const adminToken = process.env.ADMIN_API_TOKEN ?? "";
console.log("ADMIN_API_TOKEN present:", Boolean(adminToken), "len:", adminToken.length);

function open(url, label, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const got = [];
    let opened = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ label, opened, got, err: "timeout" }); }, 8000);
    ws.on("open", () => {
      opened = true;
      if (opts.send) {
        // Send AFTER receiving the state frame
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "send", clientMsgId: opts.cmid, body: opts.send }));
        }, 300);
      }
      setTimeout(() => { clearTimeout(timer); try { ws.close(); } catch {} resolve({ label, opened, got }); }, 3500);
    });
    ws.on("message", (d) => { got.push(JSON.parse(d.toString())); });
    ws.on("error", (e) => { clearTimeout(timer); resolve({ label, opened, got, err: e.message }); });
  });
}

const cmid = `t-${Date.now()}`;

const viewerPromise = open("ws://localhost:8080/api/chat/ws?channel=temple-tv-live", "viewer");
await new Promise((r) => setTimeout(r, 200));

const mod = await open(
  `ws://localhost:8080/api/chat/ws?channel=temple-tv-live&token=${encodeURIComponent(adminToken)}`,
  "mod",
  { send: "verification ping from moderator", cmid },
);
const viewer = await viewerPromise;

console.log("MOD all frames:", JSON.stringify(mod.got, null, 2));
console.log("VIEWER all frames:", JSON.stringify(viewer.got, null, 2));
