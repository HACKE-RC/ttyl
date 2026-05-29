// End-to-end relay test against a running dev/deployed ttyl Worker.
// Usage: node test/e2e.mjs [baseURL]   (default http://127.0.0.1:8787)
//
// Exercises the full protocol the Go client and browser viewer rely on:
// fan-out of output/resize, viewer->broadcaster input, scrollback + resize
// replay to late joiners, and session teardown when the broadcaster leaves.

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

const KIND_OUTPUT = 0;
const KIND_INPUT = 1;
const KIND_RESIZE = 2;
const KIND_AUTH = 3;

const te = new TextEncoder();
const td = new TextDecoder();

function frameOutput(s) {
  const d = te.encode(s);
  const b = new Uint8Array(1 + d.length);
  b[0] = KIND_OUTPUT;
  b.set(d, 1);
  return b;
}
function frameInput(s) {
  const d = te.encode(s);
  const b = new Uint8Array(1 + d.length);
  b[0] = KIND_INPUT;
  b.set(d, 1);
  return b;
}
function frameResize(cols, rows) {
  const b = new Uint8Array(5);
  b[0] = KIND_RESIZE;
  new DataView(b.buffer).setUint16(1, cols, false);
  new DataView(b.buffer).setUint16(3, rows, false);
  return b;
}
function frameAuth(key) {
  const d = te.encode(key);
  const b = new Uint8Array(1 + d.length);
  b[0] = KIND_AUTH;
  b.set(d, 1);
  return b;
}
function parse(buf) {
  const b = new Uint8Array(buf);
  const kind = b[0];
  if (kind === KIND_RESIZE) {
    const v = new DataView(b.buffer, b.byteOffset);
    return { kind, cols: v.getUint16(1, false), rows: v.getUint16(3, false) };
  }
  return { kind, text: td.decode(b.subarray(1)) };
}

// open connects and, once open, sends the Auth handshake (auth = the control
// key, "" for view-only, or null to skip). Tracks frames and the close code.
function open(url, auth) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.frames = [];
    ws.closed = false;
    ws.addEventListener("message", (e) => ws.frames.push(parse(e.data)));
    ws.addEventListener("close", () => {
      ws.closed = true;
    });
    ws.addEventListener("open", () => {
      if (auth !== null && auth !== undefined) ws.send(frameAuth(auth));
      resolve(ws);
    });
    ws.addEventListener("error", () => reject(new Error(`ws error: ${url}`)));
  });
}

function closedWithin(ws, ms) {
  return new Promise((r) => {
    if (ws.closed) return r(true);
    ws.addEventListener("close", () => r(true));
    setTimeout(() => r(ws.closed), ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

async function main() {
  // 1. Create a session.
  const res = await fetch(`${BASE}/api/sessions`, { method: "POST" });
  const { id, key } = await res.json();
  check("create session returns 24-char id", typeof id === "string" && id.length === 24);
  check("create session returns a control key", typeof key === "string" && key.length === 24);

  // 1b. Broadcasting requires the control key via the Auth handshake; an empty
  // key is rejected and the socket is closed.
  const badBcast = await open(`${WS_BASE}/ws/${id}/broadcast`, "");
  check("broadcast with wrong/empty key is rejected", await closedWithin(badBcast, 1500));

  // 2. Broadcaster authenticates with the key; two read-write viewers join.
  const b = await open(`${WS_BASE}/ws/${id}/broadcast`, key);
  const v1 = await open(`${WS_BASE}/ws/${id}/view`, key);
  const v2 = await open(`${WS_BASE}/ws/${id}/view`, key);
  await sleep(200);

  // 2b. Only one broadcaster may be live: a second authed broadcaster is closed.
  const b2 = await open(`${WS_BASE}/ws/${id}/broadcast`, key);
  check("second broadcaster is rejected", await closedWithin(b2, 1500));

  // 3. Broadcaster sends resize + output; both viewers receive them.
  b.send(frameResize(120, 40));
  b.send(frameOutput("hello world\r\n"));
  await sleep(250);

  const v1Resize = v1.frames.find((f) => f.kind === KIND_RESIZE);
  const v2Resize = v2.frames.find((f) => f.kind === KIND_RESIZE);
  check("viewer1 got resize 120x40", v1Resize?.cols === 120 && v1Resize?.rows === 40);
  check("viewer2 got resize 120x40", v2Resize?.cols === 120 && v2Resize?.rows === 40);
  check(
    "viewer1 got output",
    v1.frames.some((f) => f.kind === KIND_OUTPUT && f.text.includes("hello world")),
  );
  check(
    "viewer2 got output",
    v2.frames.some((f) => f.kind === KIND_OUTPUT && f.text.includes("hello world")),
  );

  // 4. Read-write viewer input reaches the broadcaster (not echoed to viewers).
  v1.send(frameInput("ls -la\n"));
  await sleep(250);
  check(
    "read-write viewer input reaches broadcaster",
    b.frames.some((f) => f.kind === KIND_INPUT && f.text === "ls -la\n"),
  );
  const v2InputCount = v2.frames.filter((f) => f.kind === KIND_INPUT).length;
  check("viewer input not echoed to other viewers", v2InputCount === 0);

  // 4b. A VIEW-ONLY viewer (empty key) can watch but its input is dropped.
  const ro = await open(`${WS_BASE}/ws/${id}/view`, "");
  await sleep(200);
  const roSeesOutput = ro.frames.some((f) => f.kind === KIND_OUTPUT && f.text.includes("hello world"));
  check("view-only viewer receives output", roSeesOutput);
  ro.send(frameInput("rm -rf /\n"));
  await sleep(250);
  check(
    "view-only viewer input is NOT forwarded to broadcaster",
    !b.frames.some((f) => f.kind === KIND_INPUT && f.text === "rm -rf /\n"),
  );

  // 5. More output, then a LATE viewer joins and gets replay (resize + scrollback).
  b.send(frameOutput("line two\r\n"));
  await sleep(200);
  const late = await open(`${WS_BASE}/ws/${id}/view`, "");
  await sleep(250);
  const lateResize = late.frames.find((f) => f.kind === KIND_RESIZE);
  const lateOutput = late.frames.filter((f) => f.kind === KIND_OUTPUT).map((f) => f.text).join("");
  check("late viewer got resize replay", lateResize?.cols === 120 && lateResize?.rows === 40);
  check("late viewer got scrollback (hello world)", lateOutput.includes("hello world"));
  check("late viewer got scrollback (line two)", lateOutput.includes("line two"));

  // 6. /s/{id} resolves while live.
  const liveCode = (await fetch(`${BASE}/s/${id}`)).status;
  check("viewer page 200 while live", liveCode === 200);

  // 7. Broadcaster disconnects -> session ends, viewers closed, page 404s.
  const v1Closed = new Promise((r) => v1.addEventListener("close", () => r(true)));
  b.close();
  const closedInTime = await Promise.race([v1Closed, sleep(1500).then(() => false)]);
  check("viewer socket closed after broadcaster left", closedInTime === true);
  await sleep(200);
  const deadCode = (await fetch(`${BASE}/s/${id}`)).status;
  check("viewer page 404 after session ended", deadCode === 404);

  // 8. Session creation is rate limited: a burst from one client hits 429.
  let got429 = false;
  for (let i = 0; i < 30 && !got429; i++) {
    const r = await fetch(`${BASE}/api/sessions`, { method: "POST" });
    if (r.status === 429) got429 = true;
    else if (r.ok) await r.json();
  }
  check("session creation is rate limited (429 within a burst)", got429);

  for (const ws of [v2, late, ro]) try { ws.close(); } catch {}

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
