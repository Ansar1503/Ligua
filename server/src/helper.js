import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function pcmToWav(pcm, sampleRate = 16000) {
  const channels = 1;
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);

  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);

  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);

  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);

  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export async function saveDebugAudio(audioChunks) {
  if (!audioChunks?.length) {
    console.log("No audio chunks available to save.");
    return;
  }

  try {
    const pcm = Buffer.concat(audioChunks);
    const wav = pcmToWav(pcm);

    const debugDir = path.resolve(__dirname, "../debug-audio");

    await mkdir(debugDir, { recursive: true });

    const filename = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;

    const outputPath = path.join(debugDir, filename);

    await writeFile(outputPath, wav);

    return outputPath;
  } catch (error) {
    console.error("Could not save debug WAV:", error.message);
  }
}
