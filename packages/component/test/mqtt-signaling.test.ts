/**
 * Proves signaling works over a public MQTT broker with no self-hosted server.
 *
 *   npm run test:mqtt      (from packages/component)
 *
 * Spins up two peers in one Node process — one `agent`, one `client` — points
 * them at the public EMQX broker, and checks they can find each other and
 * exchange offer/answer/ICE. Also checks that a peer with the wrong secret is
 * blind to the channel.
 *
 * Requires outbound access to broker.emqx.io. Node >= 22 (global WebSocket,
 * WebCrypto, btoa).
 */

import { MqttSignalingClient, PUBLIC_MQTT_BROKER } from "../src/signaling-mqtt";
import type { SignalMessage } from "../src/signaling";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function waitFor(
  client: MqttSignalingClient,
  type: SignalMessage["type"],
  predicate: (message: SignalMessage) => boolean = () => true,
  timeoutMs = 20_000,
): Promise<SignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout after ${timeoutMs}ms waiting for "${type}"`)),
      timeoutMs,
    );
    client.on(type, (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const room = `etproxy-test-${Date.now().toString(36)}`;
  const secret = `s-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const presenceIntervalMs = 1000; // faster presence for a short test

  console.log(`broker : ${PUBLIC_MQTT_BROKER}`);
  console.log(`room   : ${room}`);
  console.log(`secret : ${secret.slice(0, 12)}…\n`);

  const agent = new MqttSignalingClient({ room, secret, role: "agent", presenceIntervalMs });
  const browser = new MqttSignalingClient({ room, secret, role: "client", presenceIntervalMs });

  console.log("[1] connect to the public broker");
  await Promise.all([agent.ready, browser.ready]);
  check("agent connected and subscribed", agent.ready !== undefined, `id=${agent.id}`);
  check("browser connected and subscribed", browser.ready !== undefined, `id=${browser.id}`);

  console.log("\n[2] mutual discovery (presence messages)");
  const browserSeesAgent = await waitFor(browser, "peer-joined", (m) => m.role === "agent");
  check(
    "browser discovered the agent",
    browserSeesAgent.role === "agent",
    `agent id=${browserSeesAgent.id}`,
  );

  const agentSeesBrowser = await waitFor(agent, "peer-joined", (m) => m.role === "client");
  check(
    "agent discovered the browser",
    agentSeesBrowser.role === "client",
    `client id=${agentSeesBrowser.id}`,
  );

  console.log("\n[3] offer / answer exchange");
  const offerAtAgent = waitFor(agent, "offer");
  const answerAtBrowser = waitFor(browser, "answer");

  browser.send({
    type: "offer",
    sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=test-offer",
    to: browserSeesAgent.id,
  });

  const offer = await offerAtAgent;
  check("agent received the offer", offer.sdp?.includes("test-offer") === true);
  check("offer carried the sender id", typeof offer.from === "string" && offer.from.length > 0, offer.from);

  agent.send({
    type: "answer",
    sdp: "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=test-answer",
    to: offer.from,
  });

  const answer = await answerAtBrowser;
  check("browser received the answer", answer.sdp?.includes("test-answer") === true);

  console.log("\n[4] ICE candidate exchange (both directions)");
  const iceAtAgent = waitFor(agent, "ice");
  const iceAtBrowser = waitFor(browser, "ice");

  browser.send({ type: "ice", candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host", to: agent.id });
  agent.send({ type: "ice", candidate: "candidate:2 1 udp 2 10.0.0.2 6000 typ host", to: browser.id });

  const [{ candidate: fromClient }, { candidate: fromAgent }] = await Promise.all([
    iceAtAgent,
    iceAtBrowser,
  ]);
  check("agent received the client candidate", fromClient?.includes("10.0.0.1") === true, fromClient?.slice(0, 40));
  check("browser received the agent candidate", fromAgent?.includes("10.0.0.2") === true, fromAgent?.slice(0, 40));

  console.log("\n[5] a peer with the wrong secret must be blind");
  const eavesdropper = new MqttSignalingClient({
    room,
    secret: `${secret}-wrong`,
    role: "client",
    presenceIntervalMs,
  });
  await eavesdropper.ready;

  let leaked = 0;
  for (const type of ["offer", "answer", "ice", "peer-joined"] as const) {
    eavesdropper.on(type, () => {
      leaked += 1;
    });
  }

  browser.send({ type: "offer", sdp: "v=0\r\ns=should-not-leak", to: agent.id });
  await delay(2500);
  check("no messages reached the wrong-secret peer", leaked === 0, `received ${leaked}`);

  agent.close();
  browser.close();
  eavesdropper.close();
  await delay(200);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFATAL: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
