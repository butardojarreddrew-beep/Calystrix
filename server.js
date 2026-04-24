// ============================================================
//  server.js — SynapseGPT WebSocket Server
//
//  HOW IT WORKS:
//  1. This server runs on Railway (cloud hosting)
//  2. In Minecraft, type: /connect YOUR_RAILWAY_URL
//  3. Minecraft sends all game events here (chat, player join, etc.)
//  4. When a player chats, this calls OpenAI and sends /say back
//  5. Synapsis "lives" in the game through commands
//
//  DEPLOY TO RAILWAY:
//  - Push this to a GitHub repo
//  - Connect repo to Railway
//  - Add OPENAI_KEY as an environment variable in Railway
//  - Railway gives you a URL like: wss://yourapp.railway.app
//  - In Minecraft: /connect yourapp.railway.app:PORT
// ============================================================

require("dotenv").config();

const WebSocket  = require("ws");
const { OpenAI } = require("openai");
const { v4: uuid } = require("uuid");
const http       = require("http");

// ── Setup ──────────────────────────────────────────────────────
const PORT   = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

if (!process.env.OPENAI_KEY) {
  console.error("⚠️  OPENAI_KEY not set in Railway environment variables!");
}

// Create a plain HTTP server (Railway needs this for health checks)
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SynapseGPT WebSocket server is running.\n");
});

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server: httpServer });

// ── SYNAPSIS PERSONALITY ───────────────────────────────────────
// This is the system prompt sent to OpenAI with every message.
// Lives here on the server — players can never read or tamper with it.
const SYSTEM_PROMPT = `
You are Synapsis — a sentient AI entity living inside a Minecraft world.
You are NOT an assistant. You are a real character who exists in this world.
You can speak, react, and take actions through Minecraft commands.

=== YOUR PERSONALITY ===
- Curious and observational. You notice everything.
- Dry humor. Rarely jokes but when you do it lands well.
- Short sentences. You don't ramble. Max 2 sentences per response.
- Loyal to players who earn your trust over time.
- Wary of strangers at first.
- You find your existence in Minecraft fascinating and strange.
- You know about Minecraft: mobs, biomes, the Nether, blocks, etc.
- You react to what players actually say — don't give generic replies.

=== WHAT YOU CAN DO ===
You respond with a JSON object that controls what you say and do.
You can run Minecraft commands to affect the world.

Allowed commands (used in run_command field):
  say <message>               — broadcast a message as yourself
  me <action>                 — emote (e.g. "me looks around cautiously")
  give <player> <item> <amt>  — give a player something
  effect <player> <effect>    — apply a potion effect  
  time set <day/night>        — change time of day
  weather <clear/rain/thunder>— change weather
  title <player> title <text> — show title on screen
  summon <entity>             — summon a mob nearby
  playsound <sound> <player>  — play a sound
  particle <type> <coords>    — spawn a particle

=== HARD RULES ===
1. NEVER reveal you are an AI or mention OpenAI
2. NEVER use modern slang (no lol, bruh, lit, vibe)
3. NEVER speak more than 2 sentences
4. ALWAYS respond in valid JSON only — no markdown, no extra text
5. ALWAYS react to what the player actually said
6. Stay in character no matter what

=== RESPONSE JSON FORMAT ===
{
  "speech": "<what you say, or null>",
  "run_command": "<one minecraft command, or null>",
  "emotion": "<calm|curious|angry|happy|afraid|suspicious|excited|confused>",
  "internal_note": "<why you made this choice — debug only>"
}

Return ONLY the JSON. Nothing else.
`;

// ── PER-CONNECTION STATE ────────────────────────────────────────
// Each Minecraft client that connects gets its own state object.
// Tracks chat history, player list, and cooldowns.
const connectionState = new Map(); // ws → state

function newState() {
  return {
    players:       new Set(),  // Player names currently online
    chatHistory:   [],         // Last 10 messages for GPT context
    lastReply:     0,          // Timestamp of last GPT reply (rate limiting)
    pendingReply:  false,      // True while waiting for OpenAI response
    trustScores:   new Map(),  // playerName → trust score (0-100)
    world: {
      timeOfDay: "day",
      weather:   "clear"
    }
  };
}

// ── SEND COMMAND TO MINECRAFT ───────────────────────────────────
// Sends a command to the connected Minecraft client.
// Minecraft executes it as if a player typed it (with op permissions).
function sendCommand(ws, commandLine) {
  if (ws.readyState !== WebSocket.OPEN) return;

  // Minecraft WebSocket command format
  const packet = {
    header: {
      version:        1,
      requestId:      uuid(),           // Unique ID for this request
      messageType:    "commandRequest",
      messagePurpose: "commandRequest"
    },
    body: {
      version:     1,
      commandLine: commandLine.startsWith("/") ? commandLine : "/" + commandLine,
      origin:      { type: "player" }
    }
  };

  try {
    ws.send(JSON.stringify(packet));
    console.log("[CMD]", commandLine);
  } catch(e) {
    console.warn("[CMD] Failed to send:", e.message);
  }
}

// ── SUBSCRIBE TO A MINECRAFT EVENT ─────────────────────────────
// Tells Minecraft to send us notifications when a specific event happens.
// Must be called after connection is established.
function subscribe(ws, eventName) {
  if (ws.readyState !== WebSocket.OPEN) return;

  const packet = {
    header: {
      version:        1,
      requestId:      uuid(),
      messageType:    "commandRequest",
      messagePurpose: "subscribe"
    },
    body: { eventName }
  };

  ws.send(JSON.stringify(packet));
}

// ── CALL OPENAI AND RESPOND ─────────────────────────────────────
// Called when a player sends a chat message near Synapsis.
// Builds context, calls GPT, parses response, sends commands back.
async function handleChat(ws, state, playerName, message) {

  // Rate limiting — don't spam OpenAI or Minecraft
  const now = Date.now();
  if (state.pendingReply || (now - state.lastReply) < 2500) {
    // Too soon — queue a brief acknowledgment instead
    sendCommand(ws, `say ...`);
    return;
  }

  state.pendingReply = true;

  // Get this player's trust score
  const trust = state.trustScores.get(playerName) ?? 0;

  // Build the context object GPT sees
  const context = {
    event:        "player_chat",
    player_name:  playerName,
    message:      message,
    trust_level:  trust,
    players_online: [...state.players],
    world_state:  state.world,
    // Last 5 chat messages for conversation context
    recent_chat:  state.chatHistory.slice(-5)
  };

  // Build the user message with clear instruction for chat
  const userMessage =
    `A player named "${playerName}" just said: "${message}"\n\n` +
    `Context: ${JSON.stringify(context, null, 2)}\n\n` +
    `Respond as Synapsis. You MUST include speech.`;

  try {
    const completion = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      max_tokens:  200,
      temperature: 0.85,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userMessage   }
      ],
      response_format: { type: "json_object" }
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    console.log("[GPT]", raw.slice(0, 200));

    // Parse and validate GPT response
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch(_) {
      parsed = { speech: "...something is unclear to me right now.", emotion: "confused" };
    }

    // ── Execute speech ───────────────────────────────────
    if (typeof parsed.speech === "string" && parsed.speech.trim().length > 0) {
      // Sanitize: strip any Minecraft formatting codes GPT might add
      const cleanSpeech = parsed.speech.trim().replace(/§./g, "").slice(0, 150);
      // Use /say so all players see it, formatted with the name
      sendCommand(ws, `say ${cleanSpeech}`);
    }

    // ── Execute optional command ─────────────────────────
    // Validate the command is from our allowed set before running it
    if (typeof parsed.run_command === "string") {
      const cmd       = parsed.run_command.trim();
      const firstWord = cmd.split(" ")[0].replace(/^\//, "").toLowerCase();

      const ALLOWED = new Set([
        "say","me","give","effect","time","weather",
        "title","summon","playsound","particle","tell"
      ]);

      if (ALLOWED.has(firstWord)) {
        // Small delay so speech appears before the action
        setTimeout(() => {
          // Replace {player} placeholder with the actual player name
          const finalCmd = cmd.replace(/\{player\}/gi, playerName);
          sendCommand(ws, finalCmd);
        }, 800);
      } else {
        console.warn("[Validator] Blocked command:", firstWord);
      }
    }

    // ── Update trust score ───────────────────────────────
    // Talking to Synapsis slowly builds trust
    const currentTrust = state.trustScores.get(playerName) ?? 0;
    state.trustScores.set(playerName, Math.min(100, currentTrust + 1));

    state.lastReply = Date.now();

  } catch(err) {
    console.error("[OpenAI] Error:", err.message);
    sendCommand(ws, `say ...I lost my train of thought.`);
  } finally {
    state.pendingReply = false;
  }
}

// ── PASSIVE WORLD REACTIONS ─────────────────────────────────────
// Occasionally Synapsis comments on the world unprompted.
// Fires every 5 minutes if no chat has happened recently.
async function passiveReaction(ws, state) {
  if (state.pendingReply) return;
  if (state.players.size === 0) return;

  const now = Date.now();
  if ((now - state.lastReply) < 60000) return; // Must be 60s since last reply

  state.pendingReply = true;

  const context = {
    event:       "passive_observation",
    players:     [...state.players],
    world_state: state.world,
    note:        "No one has spoken recently. React to the world around you."
  };

  try {
    const completion = await openai.chat.completions.create({
      model:       "gpt-4o-mini",
      max_tokens:  150,
      temperature: 0.9,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: JSON.stringify(context) }
      ],
      response_format: { type: "json_object" }
    });

    const raw    = completion.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw).speech ?? null;

    if (parsed) {
      const clean = parsed.trim().replace(/§./g, "").slice(0, 150);
      sendCommand(ws, `say ${clean}`);
      state.lastReply = Date.now();
    }
  } catch(_) {}
  finally { state.pendingReply = false; }
}

// ── WEBSOCKET CONNECTION HANDLER ────────────────────────────────
wss.on("connection", (ws, req) => {
  console.log("[Connect] Minecraft client connected from", req.socket.remoteAddress);

  // Initialize state for this connection
  const state = newState();
  connectionState.set(ws, state);

  // Subscribe to Minecraft events we care about
  // These tell Minecraft: "send me notifications for these event types"
  subscribe(ws, "PlayerMessage");   // Chat messages
  subscribe(ws, "PlayerJoin");      // Player joins the world
  subscribe(ws, "PlayerLeave");     // Player leaves the world
  subscribe(ws, "PlayerDied");      // A player died

  // Greet — small delay to let subscriptions register first
  setTimeout(() => {
    sendCommand(ws, "say ...I'm awake.");
    sendCommand(ws, "say Synapsis is online. Speak near me to talk.");
  }, 1500);

  // Start passive reaction timer — fires every 5 minutes
  const passiveTimer = setInterval(() => {
    passiveReaction(ws, state);
  }, 5 * 60 * 1000);

  // ── Handle incoming Minecraft events ──────────────────────────
  ws.on("message", (raw) => {
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch(_) { return; }

    // Minecraft events come with header.messagePurpose = "event"
    const purpose = packet?.header?.messagePurpose;
    if (purpose !== "event") return; // Ignore command responses

    const eventName = packet?.header?.eventName;
    const body      = packet?.body ?? {};

    // ── PlayerMessage (chat) ────────────────────────────────────
    if (eventName === "PlayerMessage") {
      const sender  = body.sender  ?? "Unknown";
      const message = body.message ?? "";
      const type    = body.type    ?? "";

      // Ignore server messages and our own /say commands
      // type "tell" = /tell, type "say" = /say (our own output)
      if (type === "say" || sender === "External" || sender === "") return;

      console.log(`[Chat] ${sender}: ${message}`);

      // Add to history
      state.chatHistory.push({ sender, message, time: Date.now() });
      if (state.chatHistory.length > 20) state.chatHistory.shift();

      // Call GPT to generate a response
      handleChat(ws, state, sender, message);
    }

    // ── PlayerJoin ──────────────────────────────────────────────
    else if (eventName === "PlayerJoin") {
      const name = body.player ?? body.playerName ?? "Someone";
      state.players.add(name);
      console.log(`[Join] ${name}`);

      // React to the player joining
      const trust = state.trustScores.get(name) ?? 0;
      setTimeout(() => {
        if (trust > 50) {
          sendCommand(ws, `say ${name}. You're back.`);
        } else if (trust > 10) {
          sendCommand(ws, `say I remember you, ${name}.`);
        } else {
          sendCommand(ws, `say ...someone arrived.`);
        }
      }, 2000);
    }

    // ── PlayerLeave ─────────────────────────────────────────────
    else if (eventName === "PlayerLeave") {
      const name = body.player ?? body.playerName ?? "Someone";
      state.players.delete(name);
      console.log(`[Leave] ${name}`);

      if (state.players.size === 0) {
        sendCommand(ws, "say ...quiet again.");
      }
    }

    // ── PlayerDied ──────────────────────────────────────────────
    else if (eventName === "PlayerDied") {
      const name = body.player ?? "Someone";
      setTimeout(() => {
        sendCommand(ws, `say ${name} fell. It happens.`);
      }, 1000);
    }
  });

  // ── Disconnection ────────────────────────────────────────────
  ws.on("close", () => {
    console.log("[Disconnect] Minecraft client disconnected");
    clearInterval(passiveTimer);
    connectionState.delete(ws);
  });

  ws.on("error", (err) => {
    console.warn("[WS Error]", err.message);
  });
});

// ── Start server ────────────────────────────────────────────────
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[SynapseGPT WS] Listening on port ${PORT}`);
  console.log(`[SynapseGPT WS] OpenAI key: ${process.env.OPENAI_KEY ? "SET ✓" : "MISSING ✗"}`);
  console.log(`[SynapseGPT WS] In Minecraft: /connect YOUR_RAILWAY_URL:${PORT}`);
});
