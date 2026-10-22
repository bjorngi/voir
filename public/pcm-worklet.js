// AudioWorklet: microphone → 16-bit PCM at 24kHz, mono.
//
// Loaded by the voice-conversation client (app/lib/use-voice.ts)
// via `audioCtx.audioWorklet.addModule("/pcm-worklet.js")`. The
// browser's capture graph runs at the device rate (typically
// 48kHz); this processor downsamples to 24kHz with linear
// interpolation, converts to Int16, and posts ~40ms batches to
// the main thread, which forwards them as WebSocket binary frames.
//
// No imports allowed in worklet scope — this file is plain JS
// loaded directly by the audio graph.

const TARGET_RATE = 24000;
const FLUSH_SAMPLES = 960; // 40ms at 24kHz — keeps WS frame rate ~25/s

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // input frames per output frame
    this.phase = 0; // fractional position in the input stream
    this.pending = new Float32Array(0); // unprocessed input frames
    this.out = []; // Int16 samples awaiting flush
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    // Append the incoming block to any pending frames.
    const joined = new Float32Array(this.pending.length + ch.length);
    joined.set(this.pending, 0);
    joined.set(ch, this.pending.length);

    // Walk the input at `ratio` steps; each step yields one output
    // sample, linearly interpolated between neighbouring inputs.
    let pos = this.phase;
    while (pos + 1 < joined.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const s = joined[i] * (1 - frac) + joined[i + 1] * frac;
      const v = Math.max(-1, Math.min(1, s));
      this.out.push(Math.round(v * 32767));
      pos += this.ratio;
    }

    // Keep the unprocessed remainder (one extra frame back, for
    // the interpolation of the next block's first sample).
    const consumed = Math.max(0, Math.floor(pos) - 1);
    this.pending = joined.slice(consumed);
    this.phase = pos - consumed;

    if (this.out.length >= FLUSH_SAMPLES) {
      const pcm = new Int16Array(this.out);
      this.out.length = 0;
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);