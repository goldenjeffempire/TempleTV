import WebSocket from "ws";

function open(url, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const got = [];
    let opened = false;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ label, opened, got, err: "timeout" });
    }, 5000);
    ws.on("open", () => {
      opened = true;
      // send a test message
      ws.send(JSON.stringify({ type: "send", clientMsgId: `t-${label}-${Date.now()}`, body: `hello from ${label}` }));
      setTimeout(() => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ label, opened, got });
      }, 1500);
    });
    ws.on("message", (d) => { got.push(JSON.parse(d.toString())); });
    ws.on("error", (e) => { clearTimeout(timer); resolve({ label, opened, got, err: e.message }); });
  });
}

const adminToken = process.env.ADMIN_API_TOKEN ?? "";
const r1 = await open("ws://localhost:8080/api/chat/ws?channel=temple-tv-live", "anon");
console.log("ANON:", JSON.stringify(r1, null, 2).slice(0, 1200));
const r2 = await open(`ws://localhost:8080/api/chat/ws?channel=temple-tv-live&token=${encodeURIComponent(adminToken)}`, "mod");
console.log("MOD:", JSON.stringify(r2, null, 2).slice(0, 1500));
