/**
 * Energy-based utterance segmentation, used by the mock STT
 * provider (app/lib/voice-server.ts) when no real STT key is
 * configured. The real providers (Deepgram &c.) do their own VAD
 * server-side; this is the key-free stand-in that makes the whole
 * voice-conversation loop developable and demoable.
 *
 * Frame-based: the caller feeds one RMS value per frame (the mock
 * computes RMS over 10ms PCM windows) and gets back speech-start
 * / utterance-end events. An utterance ends after `silenceMs` of
 * continuous sub-threshold frames while speech was seen.
 */
export interface SegmenterEvent {
  type: "speech_start" | "utterance_end";
}

export interface SegmenterOptions {
  /** Duration covered by one feed() call, in ms. */
  frameMs: number;
  /** Frames with RMS ≥ this count as voiced. Normalized 0..1. */
  speechRms: number;
  /** Continuous silence that ends an utterance, in ms. */
  silenceMs: number;
}

export class UtteranceSegmenter {
  private inSpeech = false;
  private speechSeen = false;
  private lastVoiceAt = 0;
  private t = 0;

  constructor(private readonly opts: SegmenterOptions) {}

  /**
   * Feed one frame's RMS (normalized 0..1, computed by the caller
   * from PCM16 samples). Returns the events for this frame.
   */
  feed(rms: number): SegmenterEvent[] {
    this.t += this.opts.frameMs;
    const voiced = rms >= this.opts.speechRms;
    if (voiced) {
      this.lastVoiceAt = this.t;
      if (!this.inSpeech) {
        this.inSpeech = true;
        this.speechSeen = true;
        return [{ type: "speech_start" }];
      }
      return [];
    }
    if (this.inSpeech && this.t - this.lastVoiceAt >= this.opts.silenceMs) {
      this.inSpeech = false;
      return [{ type: "utterance_end" }];
    }
    return [];
  }

  /** Whether any voice has been seen in this session (so silence
   *  alone doesn't "end" an utterance that never started). */
  get sawSpeech(): boolean {
    return this.speechSeen;
  }
}

/** RMS of Int16 PCM samples, normalized to 0..1. */
export function rmsOfInt16(samples: Int16Array | Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = (samples[i] as number) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}