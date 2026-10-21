# Lingua — Real-time multilingual speech-to-text

A full-stack MVP for the Procucev AI Tech Hiring Assignment. The app streams microphone audio to Gemini Live transcription and keeps completed transcripts in PostgreSQL with create, read, update, and delete operations.

## Features

- **Live transcription UI:** microphone capture, interim/final text, elapsed time, word count, and copy-to-clipboard.
- **Multilingual recognition:** Gemini Live's automatic language detection (`languageCodes: []`), including supported code-switching.
- **History dashboard:** search, transcript list, edit title/content, delete, and aggregate word/time/session statistics.
- **Backend REST API:** validated CRUD endpoints and a health check.
- **Server-side API key:** the Gemini key is never placed in frontend JavaScript.
- **Responsive layout:** desktop and mobile layouts, loading/error/empty states, and keyboard-friendly controls.

> **MVP note:** this assignment demo has no user authentication, so a single deployed instance is a shared workspace. Do not put personal or sensitive transcripts into a public demo. Authentication and per-user data ownership are sensible production extensions.

## Stack

- React + Vite
- Node.js + Express
- Socket.IO for low-latency audio streaming/events
- Google GenAI SDK — `gemini-3.5-transcribe-live`
- PostgreSQL (`pg` driver; parameterized SQL)
- Docker / Render deployment configuration

## Architecture

```text
Browser microphone
    │
    ▼
AudioWorklet ── mono PCM16 / 16 kHz chunks (~100 ms) ──► Socket.IO
                                                         │
                                                         ▼
                                               Node.js / Express
                                                         │
                                                         ▼
                                              Gemini Live API
                                                         │
                                   interim/final transcription events
                                                         │
                              ┌──────────────────────────┴───────────┐
                              ▼                                      ▼
                       Live browser UI                       PostgreSQL
                                                               transcripts
```

The frontend converts audio samples to raw PCM 16-bit mono at 16 kHz as required by Gemini Live transcription, then streams the chunks to the backend. The backend uses a server-only `GEMINI_API_KEY`, forwards interim/final events to the browser, and saves the final transcript on stop.

## Local setup

### 1. Requirements

- Node.js 20+ (Node 22 recommended)
- Docker Desktop, or a PostgreSQL 14+ database
- A Gemini API key created at [Google AI Studio](https://aistudio.google.com/apikey)
- Chrome or another browser supporting `getUserMedia` and `AudioWorklet`; microphone capture requires localhost or HTTPS.

### 2. Start PostgreSQL

From the project root:

```bash
docker compose up -d db
```

Or configure `DATABASE_URL` to point at your existing PostgreSQL instance.

### 3. Configure environment variables

```bash
cp .env.example .env
```

Set `GEMINI_API_KEY` in `.env`, then check the local database URL. The included Docker Compose defaults are:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/speech_to_text
GEMINI_API_KEY=your_real_key_here
PORT=4000
NODE_ENV=development
```

Do not commit `.env` or share the API key in a GitHub issue, screenshot, or frontend environment variable.

### 4. Install and run

```bash
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). The Express API runs on port `4000`; Vite proxies `/api` and `/socket.io` to it. The database table and indexes are created automatically on API startup.

### 5. Production build

```bash
npm run build
npm start
```

The production server expects the client build in `server/public`. Docker builds and copies this directory automatically. For a local non-Docker production run, either use the Dockerfile or copy the result of `client/dist` to `server/public` before `npm start`.

## API design

All endpoints are served from the same origin in production.

| Method | Endpoint | Purpose | Body / query |
|---|---|---|---|
| `GET` | `/api/health` | Server, database, and Gemini-key configuration status | — |
| `GET` | `/api/stats` | Session count, total words, duration in minutes | — |
| `GET` | `/api/transcriptions` | List newest-first; supports title/content search and pagination | `?search=meeting&limit=50&offset=0` |
| `GET` | `/api/transcriptions/:id` | Read one transcript | — |
| `POST` | `/api/transcriptions` | Create a transcript manually / save a draft | `{ "title": "Meeting notes", "content": "...", "language": "auto", "durationSeconds": 38 }` |
| `PATCH` | `/api/transcriptions/:id` | Update title and/or content | `{ "title": "Updated title" }` or `{ "content": "Updated text" }` |
| `DELETE` | `/api/transcriptions/:id` | Delete a transcript | — |

### Live Socket.IO events

| Direction | Event | Payload / meaning |
|---|---|---|
| Client → server | `transcription:start` | `{ title?: string }`; open Gemini Live session |
| Client → server | `audio:chunk` | Binary PCM16 audio chunk at 16 kHz mono |
| Client → server | `transcription:stop` | End audio, finalize, and persist transcript |
| Server → client | `transcription:ready` | Gemini session is ready to receive audio |
| Server → client | `transcription:interim` | Partial text (can change as speech continues) |
| Server → client | `transcription:final` | Finalized segment to append to transcript |
| Server → client | `transcription:saved` | `{ record }` after successful persistence |
| Server → client | `transcription:error` | `{ message }` for setup, streaming, or persistence errors |

## Database schema

The schema is defined in `server/db/schema.sql` and also initialized at startup.

| Column | Type | Rules / purpose |
|---|---|---|
| `id` | `BIGSERIAL` | Primary key |
| `title` | `VARCHAR(160)` | Required display title |
| `content` | `TEXT` | Final transcript text |
| `language` | `VARCHAR(40)` | Language hint / detection mode; defaults to `auto` |
| `duration_seconds` | `NUMERIC(10,2)` | Recorded session duration; non-negative |
| `word_count` | `INTEGER` | Derived from transcript content; non-negative |
| `created_at` | `TIMESTAMPTZ` | Creation time |
| `updated_at` | `TIMESTAMPTZ` | Last edit time |

Indexes: `created_at DESC` for recent-history reads and `title` for title filtering. There is no user table because authentication is intentionally out of scope for this time-boxed assignment.

## Deploy on Render (Docker)

The repository includes `render.yaml` and `Dockerfile` as a deployment starting point.

1. Push this repository to your GitHub account.
2. In Render, create a new Blueprint from the GitHub repository and review the services in `render.yaml`.
3. Add `GEMINI_API_KEY` as a secret in the `lingua-speech-to-text` web service environment.
4. Deploy and wait for the service to become healthy. The database table initializes on startup.
5. Open the `onrender.com` URL. Grant microphone permission and test a short English/Hindi mixed sentence.
6. Confirm `GET /api/health`, then create, edit, and delete a transcript.

If the free plan isn't available or is suspended on your account, choose a supported web-service/database plan. The database must be reachable from the web service, and the service should use HTTPS so browser microphone APIs are allowed.

## Important limitations / next improvements

- No login or per-user access control yet; deployment is intended only for a controlled assessment demo.
- Live transcription requires network access and a valid Gemini API key/model access. The app displays a configuration error if the key is missing.
- Gemini Live sessions are best tested with short recordings first. API quotas and model availability depend on the Google AI Studio project/account.
- Add authentication, request rate limits, user-scoped queries, automated tests, structured logging, and stronger privacy controls before production use.

## Suggested demo flow for the reviewer

1. Open the dashboard and click **Start recording**.
2. Speak: “Kal ka meeting at ten AM hai, please send the updated document before lunch.”
3. Watch the live transcript update; click **Stop recording**.
4. Confirm the session appears in Recent transcriptions with word/time statistics.
5. Edit its title or transcript, refresh the page, and delete it.

## Submission note

Before emailing the recruiter, replace the placeholder values in the email template with your actual deployed app URL and GitHub repository URL. Only claim that a live deployed demo works after you have configured the API key and personally tested the hosted URL.

# Ligua
live transcription ai
