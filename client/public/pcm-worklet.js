
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.outputRate = 16000;
    this.ratio = sampleRate / this.outputRate;
    this.nextSamplePosition = 0;
    this.totalInputSamples = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input || input.length === 0) return true;

    const start = this.totalInputSamples;
    const end = start + input.length;
    let targetPosition = this.nextSamplePosition;

    while (targetPosition < end) {
      const localIndex = Math.floor(targetPosition - start);
      if (localIndex >= 0 && localIndex < input.length) {
        const sample = Math.max(-1, Math.min(1, input[localIndex]));
        this.pending.push(sample < 0 ? sample * 32768 : sample * 32767);
      }
      targetPosition += this.ratio;
    }

    this.nextSamplePosition = targetPosition;
    this.totalInputSamples = end;

    while (this.pending.length >= 1600) {
      const chunk = this.pending.splice(0, 1600);
      const pcm = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i += 1) pcm[i] = chunk[i];
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
