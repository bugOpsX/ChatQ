// Procedural Web Audio API sound generator for ChatQ (Zero external audio file dependencies)
class SoundManager {
  constructor() {
    this.ctx = null;
    this.ringtoneInterval = null;
    this.ringbackInterval = null;
  }

  initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  // Play a clean pleasant notification ping for new incoming messages
  playMessagePing() {
    this.initContext();
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.08); // A5

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.3);
  }

  // Play incoming call ringtone (modern marimba / chime melody repeating)
  startIncomingRingtone() {
    this.stopIncomingRingtone();
    this.initContext();

    const playMelody = () => {
      const notes = [
        { f: 523.25, d: 0.12, t: 0.0 },  // C5
        { f: 659.25, d: 0.12, t: 0.14 }, // E5
        { f: 783.99, d: 0.12, t: 0.28 }, // G5
        { f: 1046.50, d: 0.25, t: 0.42 } // C6
      ];

      const startTime = this.ctx.currentTime;
      notes.forEach(({ f, d, t }) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, startTime + t);

        gain.gain.setValueAtTime(0, startTime + t);
        gain.gain.linearRampToValueAtTime(0.25, startTime + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + t + d + 0.1);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(startTime + t);
        osc.stop(startTime + t + d + 0.12);
      });
    };

    playMelody();
    this.ringtoneInterval = setInterval(playMelody, 2000);
  }

  stopIncomingRingtone() {
    if (this.ringtoneInterval) {
      clearInterval(this.ringtoneInterval);
      this.ringtoneInterval = null;
    }
  }

  // Play outgoing ringback (soft pulsing tone indicating calling target)
  startOutgoingRingback() {
    this.stopOutgoingRingback();
    this.initContext();

    const playPulse = () => {
      const now = this.ctx.currentTime;
      const osc1 = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(440, now);
      osc2.frequency.setValueAtTime(480, now);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
      gain.gain.setValueAtTime(0.12, now + 1.2);
      gain.gain.linearRampToValueAtTime(0.001, now + 1.3);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 1.3);
      osc2.stop(now + 1.3);
    };

    playPulse();
    this.ringbackInterval = setInterval(playPulse, 3200);
  }

  stopOutgoingRingback() {
    if (this.ringbackInterval) {
      clearInterval(this.ringbackInterval);
      this.ringbackInterval = null;
    }
  }

  // Descending tones when call ends
  playCallEnd() {
    this.initContext();
    const now = this.ctx.currentTime;
    const notes = [
      { f: 580, t: 0.0 },
      { f: 440, t: 0.12 },
      { f: 330, t: 0.24 }
    ];

    notes.forEach(({ f, t }) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + t);

      gain.gain.setValueAtTime(0.15, now + t);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.1);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + t);
      osc.stop(now + t + 0.11);
    });
  }
}

window.sounds = new SoundManager();
