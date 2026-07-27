// Effets sonores synthetises via WebAudio (aucun asset externe a heberger).
import type { SfxKind } from "@armabar/shared";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

function beep(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.15) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + start);
  g.gain.setValueAtTime(0.0001, ac.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, ac.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + dur + 0.02);
}

export function playSfx(kind: SfxKind) {
  switch (kind) {
    case "correct":
      beep(523, 0, 0.12, "triangle");
      beep(659, 0.1, 0.12, "triangle");
      beep(784, 0.2, 0.2, "triangle");
      break;
    case "wrong":
      beep(200, 0, 0.25, "sawtooth", 0.12);
      beep(150, 0.12, 0.3, "sawtooth", 0.12);
      break;
    case "reveal":
      beep(440, 0, 0.1, "square", 0.1);
      beep(660, 0.08, 0.18, "square", 0.1);
      break;
    case "tick":
      beep(880, 0, 0.05, "square", 0.08);
      break;
    case "podium":
      [523, 659, 784, 1047].forEach((f, i) => beep(f, i * 0.12, 0.25, "triangle"));
      break;
    case "join":
      beep(600, 0, 0.08, "sine", 0.1);
      beep(900, 0.07, 0.1, "sine", 0.1);
      break;
    case "manche":
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) =>
        beep(f, i * 0.11, 0.22, "triangle", 0.13)
      );
      break;
  }
}

/** A appeler sur un geste utilisateur pour debloquer l'audio (navigateurs). */
export function unlockAudio() {
  const ac = audio();
  if (ac && ac.state === "suspended") ac.resume();
}

// --- Musique d'ambiance generative (aucun fichier a heberger) -------------

let musicMaster: GainNode | null = null;
let musicFilter: BiquadFilterNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicVolume = 0.4;
let chordIndex = 0;

// Progression douce (La mineur -> Fa -> Do -> Sol), en frequences (Hz).
const CHORDS: number[][] = [
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [261.63, 329.63, 392.0], // C
  [196.0, 246.94, 293.66], // G
];

function musicTone(freq: number, startIn: number, dur: number, type: OscillatorType, peak: number) {
  const ac = audio();
  if (!ac || !musicMaster) return;
  const t = ac.currentTime + startIn;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(musicMaster);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function musicTick() {
  const chord = CHORDS[chordIndex % CHORDS.length];
  chordIndex++;
  // Nappe : accord tenu, doux.
  for (const f of chord) musicTone(f, 0, 3.8, "sine", 0.5);
  // Arpege leger reparti sur la mesure.
  const arp = [...chord, chord[0] * 2];
  arp.forEach((f, i) => musicTone(f, 0.2 + i * 0.7, 0.5, "triangle", 0.28));
}

export function startMusic() {
  const ac = audio();
  if (!ac || musicMaster) return;
  musicMaster = ac.createGain();
  musicMaster.gain.value = musicVolume * 0.12; // ambiance volontairement discrete
  musicFilter = ac.createBiquadFilter();
  musicFilter.type = "lowpass";
  musicFilter.frequency.value = 1100;
  musicMaster.connect(musicFilter).connect(ac.destination);
  chordIndex = 0;
  musicTick();
  musicTimer = setInterval(musicTick, 4000);
}

export function stopMusic() {
  if (musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
  const ac = audio();
  if (musicMaster && ac) {
    musicMaster.gain.setTargetAtTime(0.0001, ac.currentTime, 0.4);
    const old = musicMaster;
    const oldFilter = musicFilter;
    setTimeout(() => {
      old.disconnect();
      oldFilter?.disconnect();
    }, 1500);
  }
  musicMaster = null;
  musicFilter = null;
}

export function setMusicVolume(v: number) {
  musicVolume = Math.min(1, Math.max(0, v));
  const ac = audio();
  if (musicMaster && ac) {
    musicMaster.gain.setTargetAtTime(musicVolume * 0.12, ac.currentTime, 0.2);
  }
}

export function isMusicPlaying() {
  return musicMaster !== null;
}
