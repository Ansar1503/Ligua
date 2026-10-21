import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  AudioLines,
  AudioWaveform,
  ArrowUpRight,
  BookOpenText,
  Check,
  Clock3,
  Copy,
  FileAudio,
  FileText,
  Languages,
  LoaderCircle,
  Mic,
  Pencil,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "";
const initialStats = { total: 0, words: 0, minutes: 0 };

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function formatDate(value) {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function titleFromText(text) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return cleaned
    ? cleaned.split(/[.!?。！？]/)[0].slice(0, 52) || "Untitled transcription"
    : "Untitled transcription";
}

export default function App() {
  const [records, setRecords] = useState([]);
  const [stats, setStats] = useState(initialStats);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("idle");
  const [elapsed, setElapsed] = useState(0);
  const [finalText, setFinalText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState("Transcribe");
  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const sourceRef = useRef(null);
  const workletRef = useRef(null);
  const startedAtRef = useRef(null);
  const elapsedRef = useRef(0);
  const finalTextRef = useRef("");
  const startPendingRef = useRef(false);

  const loadRecords = useCallback(
    async (query = search) => {
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("search", query.trim());
        params.set("limit", "50");
        const response = await fetch(
          `${API_BASE}/api/transcriptions?${params}`,
        );
        if (!response.ok) throw new Error("Could not load history.");
        const body = await response.json();
        setRecords(body.data || []);
      } catch (error) {
        setNotice(
          error.message ||
            "Could not load history. Check the server connection.",
        );
      }
    },
    [search],
  );

  const loadStats = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/stats`);
      if (response.ok) setStats(await response.json());
    } catch {}
  }, []);

  useEffect(() => {
    loadRecords("");
    loadStats();
    setActiveTab("Transcribe");
  }, []);

  useEffect(() => {
    const delay = window.setTimeout(() => loadRecords(search), 220);
    return () => window.clearTimeout(delay);
  }, [search]);

  useEffect(() => {
    if (status !== "recording") return undefined;
    const tick = window.setInterval(() => {
      if (startedAtRef.current) {
        const seconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
        elapsedRef.current = seconds;
        setElapsed(seconds);
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [status]);

  const stopAudioCapture = useCallback(async () => {
    try {
      workletRef.current?.disconnect();
    } catch {}
    try {
      sourceRef.current?.disconnect();
    } catch {}
    workletRef.current = null;
    sourceRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      try {
        await audioContextRef.current.close();
      } catch {}
    }
    audioContextRef.current = null;
  }, []);

  const closeSession = useCallback(async () => {
    await stopAudioCapture();
    const socket = socketRef.current;
    if (socket?.connected) socket.emit("transcription:stop");
    else {
      socket?.disconnect();
      socketRef.current = null;
      setStatus("idle");
    }
  }, [stopAudioCapture]);

  useEffect(
    () => () => {
      stopAudioCapture();
      socketRef.current?.disconnect();
    },
    [stopAudioCapture],
  );

  const startRecording = async () => {
    if (
      startPendingRef.current ||
      status === "recording" ||
      status === "connecting"
    )
      return;
    startPendingRef.current = true;
    setNotice("");
    setFinalText("");
    finalTextRef.current = "";
    setInterimText("");
    setElapsed(0);
    elapsedRef.current = 0;
    setStatus("connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const socket = io(API_BASE || undefined, {
        transports: ["websocket", "polling"],
      });
      socketRef.current = socket;
      socket.on("connect", () =>
        socket.emit("transcription:start", { title: "Untitled transcription" }),
      );
      socket.on("transcription:ready", async () => {
        try {
          const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;
          const context = new AudioContextClass();
          audioContextRef.current = context;
          try {
            await context.audioWorklet.addModule("/pcm-worklet.js");
          } catch (error) {
            setNotice(
              "Failed to add audio worklet module. Recording may not work properly.",
            );
          }
          const source = context.createMediaStreamSource(stream);
          const worklet = new AudioWorkletNode(
            context,
            "pcm-capture-processor",
            {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [1],
            },
          );
          worklet.port.onmessage = (event) => {
            if (socket.connected) socket.emit("audio:chunk", event.data);
            else setNotice("socket connection error! please refresh the page");
          };
          source.connect(worklet);
          worklet.connect(context.destination);
          sourceRef.current = source;
          workletRef.current = worklet;
          startedAtRef.current = Date.now();
          setStatus("recording");
        } catch (error) {
          setNotice(
            error.message ||
              "Could not initialize audio capture in this browser.",
          );
          await stopAudioCapture();
          socket.emit("transcription:stop");
          setStatus("idle");
        }
      });
      socket.on("transcription:interim", (text) => setInterimText(text || ""));
      socket.on("transcription:final", (text) => {
        if (!text?.trim()) return;
        finalTextRef.current = [finalTextRef.current, text.trim()]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ");
        setFinalText(finalTextRef.current);
        setInterimText("");
      });
      socket.on("transcription:saved", ({ record }) => {
        setStatus("idle");
        setInterimText("");
        socket.disconnect();
        socketRef.current = null;
        if (record) {
          setFinalText(record.content || finalTextRef.current);
          setNotice("Transcription saved to your history.");
          loadRecords(search);
          loadStats();
        } else {
          setNotice(
            "Recording ended. No final transcript was returned, so nothing was saved.",
          );
        }
      });
      socket.on("transcription:error", async ({ message }) => {
        setNotice(
          message ||
            "Live transcription failed. Check your Gemini API key and server logs.",
        );
        setStatus("idle");
        await stopAudioCapture();
        socket.disconnect();
        socketRef.current = null;
      });
      socket.on("connect_error", (error) => {
        setNotice(
          `Could not connect to the transcription server: ${error.message}`,
        );
        setStatus("idle");
        stopAudioCapture();
      });
      socket.on("disconnect", () => {
        if (status === "recording") setStatus("idle");
      });
    } catch (error) {
      setStatus("idle");
      setNotice(
        error.name === "NotAllowedError"
          ? "Microphone permission was blocked. Allow microphone access in your browser and try again."
          : error.message || "Could not access the microphone.",
      );
      await stopAudioCapture();
    } finally {
      startPendingRef.current = false;
    }
  };

  const stopRecording = async () => {
    if (status !== "recording" && status !== "connecting") return;
    setStatus("saving");
    if (startedAtRef.current) {
      elapsedRef.current = Math.max(
        1,
        Math.floor((Date.now() - startedAtRef.current) / 1000),
      );
    }
    await closeSession();
  };

  const saveDraft = async () => {
    const content =
      `${finalTextRef.current}${interimText ? ` ${interimText}` : ""}`.trim();
    if (!content) {
      setNotice(
        "There is no transcript text to save yet. Start speaking first.",
      );
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/transcriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: titleFromText(content),
          content,
          language: "auto",
          durationSeconds: elapsed,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Unable to save transcript.");
      setNotice("Draft saved to your history.");
      loadRecords(search);
      loadStats();
    } catch (error) {
      setNotice(error.message || "Unable to save transcript.");
    }
  };

  const deleteRecord = async (record) => {
    if (!window.confirm(`Delete “${record.title}”? This cannot be undone.`))
      return;
    try {
      const response = await fetch(
        `${API_BASE}/api/transcriptions/${record.id}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Unable to delete transcription.");
      }
      setRecords((current) => current.filter((item) => item.id !== record.id));
      setNotice("Transcription deleted.");
      loadStats();
    } catch (error) {
      setNotice(error.message || "Unable to delete transcription.");
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      const response = await fetch(
        `${API_BASE}/api/transcriptions/${editing.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: editing.title,
            content: editing.content,
          }),
        },
      );
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Unable to update transcription.");
      setRecords((current) =>
        current.map((item) => (item.id === editing.id ? body.data : item)),
      );
      setEditing(null);
      setNotice("Changes saved.");
      loadStats();
    } catch (error) {
      setNotice(error.message || "Unable to update transcription.");
    }
  };

  const copyText = async (text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setNotice("Clipboard access is unavailable in this browser.");
    }
  };

  const liveContent =
    finalText ||
    (status === "recording" ? "" : "Your words will appear here as you speak.");
  const displayRecords = useMemo(() => records, [records]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark">
            <AudioWaveform size={21} strokeWidth={2.4} />
          </div>
          <div>
            <div className="brand-name">
              lingua<span>.</span>
            </div>
            <div className="brand-caption">VOICE WORKSPACE</div>
          </div>
          <button
            className="icon-button sidebar-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">
          <button
            className={`nav-item ${activeTab === "Transcribe" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("Transcribe");
              document
                .getElementById("top-section")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <AudioLines size={18} />
            <span>Transcribe</span>
            <span className="nav-shortcut">⌘ 1</span>
          </button>
          <button
            className={`nav-item ${activeTab === "History" ? "active" : ""}`}
            onClick={() => {
              setActiveTab("History");
              document
                .getElementById("history-section")
                ?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <BookOpenText size={18} />
            <span>History</span>
            <span className="nav-count">{stats.total}</span>
          </button>
        </nav>
        <div className="sidebar-divider" />
      </aside>
      {mobileNavOpen && (
        <button
          className="mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <main className="main-area">
        <div className="page-content">
          <section className="page-heading" id="top-section">
            <div>
              <div className="eyebrow">
                <span className="eyebrow-bar" /> YOUR VOICE, IN TEXT
              </div>
              <h1>
                Speech to text<span className="heading-period">.</span>
              </h1>
              <p className="page-subtitle">
                Every thought captured. In any language.
              </p>
            </div>
            <button
              className="button button-secondary new-button"
              onClick={() => {
                setFinalText("");
                finalTextRef.current = "";
                setInterimText("");
                setElapsed(0);
                setNotice("Ready for a new transcription.");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <Plus size={17} /> New session
            </button>
          </section>

          <section className="stats-grid" aria-label="Transcription statistics">
            <StatCard
              icon={<FileText size={18} />}
              label="Total transcriptions"
              value={stats.total}
              tone="violet"
            />
            <StatCard
              icon={<AudioLines size={18} />}
              label="Words captured"
              value={Number(stats.words || 0).toLocaleString()}
              tone="blue"
            />
            <StatCard
              icon={<Clock3 size={18} />}
              label="Time transcribed"
              value={`${Number(stats.minutes || 0).toLocaleString()} min`}
              tone="mint"
            />
          </section>

          <section className="recording-card" id="transcribe-section">
            <div className="recording-topline">
              <div className="recording-title-wrap">
                <div className="section-icon">
                  <Mic size={17} />
                </div>
                <div>
                  <h2>Live transcription</h2>
                  <p>Speak naturally. Watch your words appear.</p>
                </div>
              </div>
              <div className="status-pill">
                <span
                  className={`status-dot ${status === "recording" ? "status-live" : status === "connecting" || status === "saving" ? "status-pending" : ""}`}
                />
                {status === "recording"
                  ? "Recording"
                  : status === "connecting"
                    ? "Connecting"
                    : status === "saving"
                      ? "Saving transcript"
                      : "Ready to record"}
              </div>
            </div>
            <div
              className={`live-canvas ${status === "recording" ? "canvas-recording" : ""}`}
            >
              <div
                className={`wave-ring ${status === "recording" ? "wave-ring-active" : ""}`}
              >
                <div className="wave-ring-inner">
                  <AudioWaveform size={29} strokeWidth={1.65} />
                </div>
                {status === "recording" && (
                  <>
                    <span className="pulse pulse-one" />
                    <span className="pulse pulse-two" />
                  </>
                )}
              </div>
              {status === "recording" ? (
                <>
                  <div className="listening-title">
                    I'm listening
                    <span className="typing-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <p className="listening-subtitle">
                    Your speech is being transcribed in real time
                  </p>
                </>
              ) : status === "connecting" ? (
                <>
                  <div className="listening-title">
                    Getting things ready
                    <span className="typing-dots">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <p className="listening-subtitle">
                    Connecting to the live transcription engine
                  </p>
                </>
              ) : status === "saving" ? (
                <>
                  <div className="listening-title">
                    <LoaderCircle className="spin-icon" size={18} /> Saving your
                    session
                  </div>
                  <p className="listening-subtitle">
                    Finalizing the transcript and updating your history
                  </p>
                </>
              ) : (
                <>
                  <div className="listening-title">Ready when you are</div>
                  <p className="listening-subtitle">
                    Press the microphone and start speaking in Hindi, English,
                    or both.
                  </p>
                </>
              )}
              <div className="waveform-bars" aria-hidden="true">
                {Array.from({ length: 43 }, (_, i) => (
                  <span
                    key={i}
                    style={{
                      "--bar": `${8 + ((i * 17 + 11) % 27)}px`,
                      "--delay": `${(i % 13) * 0.055}s`,
                    }}
                    className={status === "recording" ? "bar-animated" : ""}
                  />
                ))}
              </div>
              <div className="language-chip">
                <Languages size={14} />
                <span>Auto language detection</span>
                <span className="language-divider" />
                Hindi · English · multilingual
              </div>
            </div>

            <div className="transcript-preview">
              <div className="preview-heading">
                <div>
                  <span className="preview-label">LIVE TRANSCRIPT</span>
                  <span className="preview-live-indicator">
                    {status === "recording" ? (
                      <>
                        <i /> LIVE
                      </>
                    ) : status === "saving" ? (
                      "SAVING"
                    ) : (
                      "PREVIEW"
                    )}
                  </span>
                </div>
                <button
                  className="text-action"
                  onClick={() =>
                    copyText(
                      `${finalText}${interimText ? ` ${interimText}` : ""}`.trim(),
                    )
                  }
                  disabled={!finalText && !interimText}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy text"}
                </button>
              </div>
              <div
                className={`transcript-text ${!finalText && !interimText ? "transcript-placeholder" : ""}`}
                aria-live="polite"
              >
                {finalText || (!interimText ? liveContent : "")}
                {finalText && interimText ? " " : ""}
                <span className="interim-text">{interimText}</span>
                {status === "recording" && <span className="cursor-blink" />}
              </div>
              <div className="preview-footer">
                <span>
                  <span className="tiny-signal" />
                  {status === "recording"
                    ? "Receiving live audio"
                    : "Your transcript preview appears here"}
                </span>
                <span>{`${(finalText.trim() + (interimText ? ` ${interimText.trim()}` : "")).trim() ? (finalText.trim() + (interimText ? ` ${interimText.trim()}` : "")).trim().split(/\s+/).length : 0} words`}</span>
              </div>
            </div>

            <div className="recording-actions">
              <div className="duration-block">
                <Clock3 size={16} />
                <span>{formatDuration(elapsed)}</span>
                <span className="duration-caption">
                  {status === "recording"
                    ? "Recording time"
                    : "Session duration"}
                </span>
              </div>
              <div className="action-buttons">
                {status === "recording" || status === "connecting" ? (
                  <button
                    className="button button-stop"
                    onClick={stopRecording}
                  >
                    <Square size={14} fill="currentColor" /> Stop recording
                  </button>
                ) : status === "saving" ? (
                  <button className="button button-primary" disabled>
                    <LoaderCircle size={16} className="spin-icon" /> Saving…
                  </button>
                ) : (
                  <button
                    className="button button-primary"
                    onClick={startRecording}
                  >
                    <span className="button-mic">
                      <Mic size={17} />
                    </span>{" "}
                    Start recording <ArrowUpRight size={16} />
                  </button>
                )}
              </div>
            </div>
          </section>
          {notice && (
            <div
              className={`notice ${notice.toLowerCase().includes("failed") || notice.toLowerCase().includes("could not") || notice.toLowerCase().includes("unable") || notice.toLowerCase().includes("blocked") ? "notice-error" : ""}`}
              role="status"
            >
              <span>{notice}</span>
              <button
                className="notice-close"
                onClick={() => setNotice("")}
                aria-label="Dismiss message"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <section className="history-section" id="history-section">
            <div className="history-heading">
              <div>
                <div className="history-overline">YOUR LIBRARY</div>
                <h2>
                  Recent transcriptions{" "}
                  <span className="history-count">{stats.total}</span>
                </h2>
              </div>
              <div className="history-tools">
                <label className="search-box">
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search transcripts..."
                    aria-label="Search transcriptions"
                  />
                  <kbd>/</kbd>
                </label>
              </div>
            </div>
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>TRANSCRIPTION</th>
                    <th>DATE CREATED</th>
                    <th>WORDS</th>
                    <th>LANGUAGE</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayRecords.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <div className="record-title-cell">
                          <div className="record-file-icon">
                            <FileAudio size={17} />
                          </div>
                          <div className="record-title-text">
                            <button
                              className="record-title-link"
                              onClick={() =>
                                setEditing({
                                  id: record.id,
                                  title: record.title,
                                  content: record.content,
                                })
                              }
                            >
                              {record.title || "Untitled transcription"}
                            </button>
                            <span>
                              {(record.content || "")
                                .replace(/\s+/g, " ")
                                .slice(0, 72) || "No transcript content"}
                              {(record.content || "").length > 72 ? "…" : ""}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="date-cell">
                          {formatDate(record.createdAt || record.created_at)}
                        </span>
                      </td>
                      <td>
                        <span className="word-count-cell">
                          {Number(
                            record.wordCount ?? record.word_count ?? 0,
                          ).toLocaleString()}{" "}
                          <span>words</span>
                        </span>
                      </td>
                      <td>
                        <span className="language-tag">
                          <span />
                          {record.language || "Auto-detect"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="table-action"
                            title="Edit transcription"
                            aria-label="Edit transcription"
                            onClick={() =>
                              setEditing({
                                id: record.id,
                                title: record.title,
                                content: record.content,
                              })
                            }
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="table-action danger-action"
                            title="Delete transcription"
                            aria-label="Delete transcription"
                            onClick={() => deleteRecord(record)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {displayRecords.length === 0 && (
                    <tr>
                      <td colSpan="5">
                        <div className="empty-history">
                          <div className="empty-icon">
                            <FileText size={22} />
                          </div>
                          <strong>
                            {search
                              ? "No matching transcriptions"
                              : "Your story starts here"}
                          </strong>
                          <p>
                            {search
                              ? "Try a different search term."
                              : "Your saved sessions will show up here after you record."}
                          </p>
                          {search && (
                            <button
                              className="text-action"
                              onClick={() => setSearch("")}
                            >
                              Clear search
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>

      {editing && (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditing(null);
          }}
        >
          <section
            className="edit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
          >
            <div className="modal-heading">
              <div>
                <span className="modal-eyebrow">TRANSCRIPTION DETAILS</span>
                <h2 id="edit-title">Edit transcription</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setEditing(null)}
                aria-label="Close editor"
              >
                <X size={18} />
              </button>
            </div>
            <label className="field-label">
              Title
              <input
                className="edit-title-input"
                value={editing.title}
                maxLength={160}
                onChange={(event) =>
                  setEditing({ ...editing, title: event.target.value })
                }
              />
            </label>
            <label className="field-label">
              Transcript
              <textarea
                className="edit-content-input"
                rows={9}
                value={editing.content}
                onChange={(event) =>
                  setEditing({ ...editing, content: event.target.value })
                }
              />
            </label>
            <div className="modal-footer">
              <button
                className="button button-secondary"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="button button-primary" onClick={saveEdit}>
                <Check size={15} /> Save changes
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, note, tone }) {
  return (
    <article className="stat-card">
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </article>
  );
}
