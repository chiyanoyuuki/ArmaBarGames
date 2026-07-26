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
  }
}

/** A appeler sur un geste utilisateur pour debloquer l'audio (navigateurs). */
export function unlockAudio() {
  const ac = audio();
  if (ac && ac.state === "suspended") ac.resume();
}
