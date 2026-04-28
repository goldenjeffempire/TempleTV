import WebSocket from "ws";

function open(url, label, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const got = [];
    let opened = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ label, opened, got, err: "timeout" }); }, 6000);
    ws.on("open", () => {
      opened = true;
      if (opts.send) {
        ws.send(JSON.stringify({ type: "send", clientMsgId: opts.cmid, body: opts.send }));
      }
      setTimeout(() => { clearTimeout(timer); try { ws.close(); } catch {} resolve({ label, opened, got }); }, 2000);
    });
    ws.on("message", (d) => { got.push(JSON.parse(d.toString())); });
    ws.on("error", (e) => { clearTimeout(timer); resolve({ label, opened, got, err: e.message }); });
  });
}

const adminToken = process.env.ADMIN_API_TOKEN ?? "";
const cmid = `t-${Date.now()}`;

// Open a viewer first so it can observe the broadcast.
const viewerPromise = open("ws://localhost:8080/api/chat/ws?channel=temple-tv-live", "viewer");
await new Promise((r) => setTimeout(r, 200));

// Moderator sends a message.
const mod = await open(
  `ws://localhost:8080/api/chat/ws?channel=temple-tv-live&token=${encodeURIComponent(adminToken)}`,
  "mod",
  { send: "verification ping from moderator", cmid },
);
const viewer = await viewerPromise;

console.log("MOD frames (last 4):", JSON.stringify(mod.got.slice(-4), null, 2).slice(0, 1500));
console.log("VIEWER frames (last 4):", JSON.stringify(viewer.got.slice(-4), null, 2).slice(0, 1500));
