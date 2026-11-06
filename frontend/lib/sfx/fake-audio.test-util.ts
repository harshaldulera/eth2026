/** Minimal fake Web Audio for engine tests (counts nodes; no sound). */
export class FakeParam {
  value = 0;
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) {
    this.events.push(["set", v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(["lin", v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (v <= 0) throw new RangeError("exp ramp to ≤ 0");
    this.events.push(["exp", v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number) {
    this.events.push(["target", v, t + c]);
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class FakeNode {
  connections: unknown[] = [];
  connect(n: unknown) {
    this.connections.push(n);
    return n;
  }
  disconnect() {
    this.connections = [];
  }
}

export class FakeSource extends FakeNode {
  started = -1;
  stopped = -1;
  onended: (() => void) | null = null;
  start(t = 0) {
    this.started = t;
  }
  stop(t = 0) {
    this.stopped = t;
  }
}

export class FakeContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  created = { osc: 0, gain: 0, buffer: 0, filter: 0, pan: 0 };
  sources: FakeSource[] = [];
  failOsc = false;
  async resume() {
    this.state = "running";
  }
  createGain() {
    this.created.gain++;
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createOscillator() {
    if (this.failOsc) throw new Error("boom");
    this.created.osc++;
    const s = Object.assign(new FakeSource(), { type: "sine", frequency: new FakeParam(), detune: new FakeParam() });
    this.sources.push(s);
    return s;
  }
  createBufferSource() {
    this.created.buffer++;
    const s = Object.assign(new FakeSource(), { buffer: null as unknown, loop: false, playbackRate: new FakeParam() });
    this.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    this.created.filter++;
    return Object.assign(new FakeNode(), { type: "lowpass", frequency: new FakeParam(), Q: new FakeParam() });
  }
  createStereoPanner() {
    this.created.pan++;
    return Object.assign(new FakeNode(), { pan: new FakeParam() });
  }
  createBuffer(_ch: number, len: number, rate: number) {
    const data = new Float32Array(len);
    return { duration: len / rate, getChannelData: () => data };
  }
  async decodeAudioData() {
    return { duration: 0.25 } as unknown as AudioBuffer;
  }
}
