export type ScanFeedbackTone = "success" | "warn" | "error";

export function playScanFeedback(tone: ScanFeedbackTone) {
  if (tone === "success" && "vibrate" in navigator) {
    try { navigator.vibrate(20); } catch { /* optional */ }
  }
  if (tone === "warn" && "vibrate" in navigator) {
    try { navigator.vibrate([20, 40, 20]); } catch { /* optional */ }
  }
  if (tone === "error" && "vibrate" in navigator) {
    try { navigator.vibrate([40, 30, 40]); } catch { /* optional */ }
  }

  try {
    const AudioContextClass = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    const start = context.currentTime;
    if (tone === "success") {
      oscillator.frequency.setValueAtTime(880, start);
      oscillator.frequency.exponentialRampToValueAtTime(1320, start + 0.08);
      gain.gain.setValueAtTime(0.16, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    } else if (tone === "warn") {
      oscillator.frequency.setValueAtTime(520, start);
      oscillator.frequency.setValueAtTime(640, start + 0.08);
      gain.gain.setValueAtTime(0.12, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
    } else {
      oscillator.frequency.setValueAtTime(220, start);
      gain.gain.setValueAtTime(0.14, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
    }
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(start + 0.2);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Optional feedback only.
  }
}
