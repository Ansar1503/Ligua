import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import pg from "pg";
import { Server as SocketIOServer } from "socket.io";
import { GoogleGenAI, Modality } from "@google/genai";
import dotenv from "dotenv";
import { saveDebugAudio } from "./helper.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
const PORT = Number(process.env.PORT || 4000);
const MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.5-transcribe-live";
const webRoot = path.resolve(__dirname, "../public");
const app = express();
const server = http.createServer(app);
const allowedOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(",").map((origin) => origin.trim())
  : true;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? false : true,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const io = new SocketIOServer(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
  maxHttpBufferSize: 1e6,
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "ws:", "wss:"],
      },
    },
  }),
);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const wordCount = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
};
const cleanTitle = (value, content = "") => {
  const title = typeof value === "string" ? value.trim() : "";
  if (title) return title.slice(0, 160);
  const generated = String(content || "")
    .trim()
    .replace(/\s+/gu, " ");
  return (generated.split(/[.!?。！？]/u)[0] || "Untitled transcription").slice(
    0,
    160,
  );
};
const positiveId = (value) => /^\d+$/.test(String(value)) && Number(value) > 0;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is not configured. Copy .env.example to .env and set it.",
    );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id BIGSERIAL PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      content TEXT NOT NULL,
      language VARCHAR(40) NOT NULL DEFAULT 'auto',
      duration_seconds NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
      word_count INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transcriptions_title ON transcriptions (title);
  `);
  console.log("PostgreSQL schema is ready.");
}

function presentRecord(row) {
  return {
    id: String(row.id),
    title: row.title,
    content: row.content,
    language: row.language,
    durationSeconds: Number(row.duration_seconds || 0),
    wordCount: Number(row.word_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

app.get(
  "/api/health",
  asyncRoute(async (_req, res) => {
    let database = "ok";
    try {
      await pool.query("SELECT 1");
    } catch {
      database = "unavailable";
    }
    res.status(database === "ok" ? 200 : 503).json({
      status: database === "ok" ? "ok" : "degraded",
      database,
      transcriptionProvider: process.env.GEMINI_API_KEY
        ? "configured"
        : "missing_api_key",
    });
  }),
);

app.get(
  "/api/stats",
  asyncRoute(async (_req, res) => {
    const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COALESCE(SUM(word_count), 0)::int AS words,
           ROUND(COALESCE(SUM(duration_seconds), 0) / 60.0)::int AS minutes
    FROM transcriptions
  `);
    res.json(rows[0]);
  }),
);

app.get(
  "/api/transcriptions",
  asyncRoute(async (req, res) => {
    const search = String(req.query.search || "")
      .trim()
      .slice(0, 160);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 50),
    );
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const { rows } = await pool.query(
      `
    SELECT id, title, content, language, duration_seconds, word_count, created_at, updated_at
    FROM transcriptions
    WHERE ($1 = '' OR title ILIKE $2 ESCAPE '\\' OR content ILIKE $2 ESCAPE '\\')
    ORDER BY created_at DESC, id DESC
    LIMIT $3 OFFSET $4
  `,
      [search, pattern, limit, offset],
    );
    res.json({
      data: rows.map(presentRecord),
      pagination: { limit, offset, returned: rows.length },
    });
  }),
);

app.get(
  "/api/transcriptions/:id",
  asyncRoute(async (req, res) => {
    if (!positiveId(req.params.id))
      return res
        .status(400)
        .json({ error: "A valid transcription ID is required." });
    const { rows } = await pool.query(
      "SELECT * FROM transcriptions WHERE id = $1",
      [req.params.id],
    );
    if (!rows[0])
      return res.status(404).json({ error: "Transcription not found." });
    return res.json({ data: presentRecord(rows[0]) });
  }),
);

app.post(
  "/api/transcriptions",
  asyncRoute(async (req, res) => {
    const content =
      typeof req.body.content === "string" ? req.body.content.trim() : "";
    if (!content)
      return res.status(400).json({ error: "Transcript content is required." });
    if (content.length > 100_000)
      return res.status(413).json({
        error: "Transcript content cannot exceed 100,000 characters.",
      });
    const title = cleanTitle(req.body.title, content);
    const language =
      typeof req.body.language === "string"
        ? req.body.language.trim().slice(0, 40) || "auto"
        : "auto";
    const duration = Number(req.body.durationSeconds || 0);
    if (!Number.isFinite(duration) || duration < 0 || duration > 86_400)
      return res
        .status(400)
        .json({ error: "Duration must be between 0 and 86,400 seconds." });
    const { rows } = await pool.query(
      `
    INSERT INTO transcriptions (title, content, language, duration_seconds, word_count)
    VALUES ($1, $2, $3, $4, $5) RETURNING *
  `,
      [title, content, language, duration, wordCount(content)],
    );
    return res.status(201).json({ data: presentRecord(rows[0]) });
  }),
);

app.patch(
  "/api/transcriptions/:id",
  asyncRoute(async (req, res) => {
    if (!positiveId(req.params.id))
      return res
        .status(400)
        .json({ error: "A valid transcription ID is required." });
    const fields = [];
    const values = [];
    if (Object.hasOwn(req.body, "title")) {
      if (typeof req.body.title !== "string" || !req.body.title.trim())
        return res.status(400).json({ error: "Title cannot be empty." });
      if (req.body.title.trim().length > 160)
        return res
          .status(400)
          .json({ error: "Title cannot exceed 160 characters." });
      values.push(req.body.title.trim());
      fields.push(`title = $${values.length}`);
    }
    if (Object.hasOwn(req.body, "content")) {
      if (typeof req.body.content !== "string" || !req.body.content.trim())
        return res
          .status(400)
          .json({ error: "Transcript content cannot be empty." });
      if (req.body.content.length > 100_000)
        return res.status(413).json({
          error: "Transcript content cannot exceed 100,000 characters.",
        });
      values.push(req.body.content.trim());
      fields.push(`content = $${values.length}`);
      values.push(wordCount(req.body.content));
      fields.push(`word_count = $${values.length}`);
    }
    if (fields.length === 0)
      return res
        .status(400)
        .json({ error: "Provide a title or content to update." });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE transcriptions SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0])
      return res.status(404).json({ error: "Transcription not found." });
    return res.json({ data: presentRecord(rows[0]) });
  }),
);

app.delete(
  "/api/transcriptions/:id",
  asyncRoute(async (req, res) => {
    if (!positiveId(req.params.id))
      return res
        .status(400)
        .json({ error: "A valid transcription ID is required." });
    const result = await pool.query(
      "DELETE FROM transcriptions WHERE id = $1",
      [req.params.id],
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Transcription not found." });
    return res.status(204).end();
  }),
);

const liveSessions = new Map();

io.on("connection", (socket) => {
  let state = null;

  socket.on("transcription:start", async ({ title } = {}) => {
    if (state) return;
    if (!process.env.GEMINI_API_KEY) {
      socket.emit("transcription:error", {
        message:
          "The server is missing GEMINI_API_KEY. Add it to .env (or your hosting secrets) and restart the server.",
      });
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const active = {
        title:
          typeof title === "string"
            ? title.slice(0, 160)
            : "Untitled transcription",
        session: null,
        finalChunks: [],
        interim: "",
        startedAt: Date.now(),
        stopping: false,
        sendQueue: Promise.resolve(),
        audioChunks: process.env.SAVE_DEBUG_AUDIO === "true" ? [] : null,
      };
      state = active;
      liveSessions.set(socket.id, active);

      active.session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (message) => {
            const content = message?.serverContent;
            if (!content) return;
            const interim = content.interimInputTranscription?.text;
            if (typeof interim === "string" && interim.trim()) {
              active.interim = interim.trim();
              socket.emit("transcription:interim", active.interim);
            }
            const finalized = content.inputTranscription?.text;
            if (typeof finalized === "string" && finalized.trim()) {
              active.finalChunks.push(finalized.trim());
              active.interim = "";
              socket.emit("transcription:final", finalized.trim());
              socket.emit("transcription:interim", "");
            }
          },
          onerror: (error) => {
            console.error("Gemini Live error:", error?.message || error);
            socket.emit("transcription:error", {
              message:
                error?.message ||
                "Gemini live transcription returned an error.",
            });
          },
          onclose: (event) => {
            if (!active.stopping)
              console.log(
                "Gemini Live session closed:",
                event?.reason || "closed",
              );
          },
        },
      });
      socket.emit("transcription:ready", { model: MODEL });
    } catch (error) {
      console.error("Unable to start Gemini Live session:", error);
      liveSessions.delete(socket.id);
      state = null;
      socket.emit("transcription:error", {
        message:
          error?.message ||
          "Unable to start the Gemini Live session. Check the API key and model access.",
      });
    }
  });

  socket.on("audio:chunk", async (chunk) => {
    if (!state || !state.session || state.stopping) return;
    const binary = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (binary.length === 0 || binary.length > 64_000) return;
    const active = state;

    if (active.audioChunks) {
      active.audioChunks.push(Buffer.from(binary));
    }
    active.sendQueue = active.sendQueue
      .then(() =>
        active.session.sendRealtimeInput({
          audio: {
            data: binary.toString("base64"),
            mimeType: "audio/pcm;rate=16000",
          },
        }),
      )
      .catch((error) => {
        console.error(
          "Unable to forward microphone chunk:",
          error?.message || error,
        );
        socket.emit("transcription:error", {
          message:
            "Audio streaming failed. Please stop and start a new session.",
        });
      });
  });

  socket.on("transcription:stop", async () => {
    if (!state || state.stopping) return;
    const active = state;
    active.stopping = true;
    if (active.audioChunks?.length) {
      await saveDebugAudio(active.audioChunks);
    }
    try {
      await active.sendQueue;
      if (active.session) {
        await active.session.sendRealtimeInput({ audioStreamEnd: true });
        await new Promise((resolve) => setTimeout(resolve, 900));
        try {
          await active.session.close();
        } catch {}
      }

      const content = active.finalChunks.join(" ").replace(/\s+/gu, " ").trim();
      let record = null;
      if (content) {
        const duration = Math.max(0, (Date.now() - active.startedAt) / 1000);
        const title = cleanTitle(
          active.title === "Untitled transcription" ? "" : active.title,
          content,
        );
        const { rows } = await pool.query(
          `
          INSERT INTO transcriptions (title, content, language, duration_seconds, word_count)
          VALUES ($1, $2, $3, $4, $5) RETURNING *
        `,
          [title, content, "auto", duration, wordCount(content)],
        );
        record = presentRecord(rows[0]);
      }
      socket.emit("transcription:saved", { record });
    } catch (error) {
      console.error("Unable to finish transcription:", error);
      socket.emit("transcription:error", {
        message:
          error?.message ||
          "Could not save this transcription. Check the database connection.",
      });
    } finally {
      liveSessions.delete(socket.id);
      state = null;
    }
  });

  socket.on("disconnect", async () => {
    const active = liveSessions.get(socket.id);
    if (active?.session) {
      active.stopping = true;
      try {
        await active.session.close();
      } catch {}
    }
    liveSessions.delete(socket.id);
  });
});

app.use(
  express.static(webRoot, {
    index: false,
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }),
);
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(
    path.join(webRoot, "index.html"),
    (error) => error && next(error),
  );
});

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error);
  const status = error?.type === "entity.too.large" ? 413 : 500;
  res.status(status).json({
    error:
      status === 413
        ? "Request body is too large."
        : "An unexpected server error occurred.",
  });
});

async function start() {
  try {
    await initializeDatabase();
  } catch (error) {
    console.error("Database initialization failed:", error.message);
    console.error(
      "The API server will not start until DATABASE_URL is configured and PostgreSQL is reachable.",
    );
    process.exitCode = 1;
    return;
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Speech-to-text server listening on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY)
      console.warn(
        "GEMINI_API_KEY is missing; history APIs work, but live transcription is disabled.",
      );
  });
}

process.on("SIGINT", async () => {
  await pool.end();
  server.close(() => process.exit(0));
});
process.on("SIGTERM", async () => {
  await pool.end();
  server.close(() => process.exit(0));
});

start();
