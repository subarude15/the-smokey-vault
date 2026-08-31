import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  IMPORT_KIND_LABELS,
  IMPORT_KINDS,
  type ImportKind
} from "./catalog";
import { playScanFeedback } from "./scan-feedback";

type Props = {
  kind: ImportKind;
  onKindChange: (kind: ImportKind) => void;
  onUpc: (upc: string) => Promise<void>;
  paused?: boolean;
  busy?: boolean;
  statusHint?: string;
};

export function ScanSessionScanner({
  kind,
  onKindChange,
  onUpc,
  paused = false,
  busy = false,
  statusHint
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | undefined>(undefined);
  const previewStream = useRef<MediaStream | undefined>(undefined);
  const cameraGen = useRef(0);
  const isProcessing = useRef(false);
  const isMounted = useRef(true);
  const [status, setStatus] = useState("Point the camera at a UPC");
  const [manualUpc, setManualUpc] = useState("");
  const [cameraBlocked, setCameraBlocked] = useState(false);

  useEffect(() => () => {
    isMounted.current = false;
    stopCamera();
  }, []);

  useEffect(() => {
    if (paused || busy) {
      stopCamera();
      return;
    }
    const gen = ++cameraGen.current;
    isProcessing.current = false;
    stopCamera();
    setStatus(statusHint ?? "Scanning…");
    void startBarcodeCamera(gen);
    return () => {
      cameraGen.current += 1;
      stopCamera();
    };
  }, [kind, paused, busy, statusHint]);

  function stopCamera() {
    controls.current?.stop();
    controls.current = undefined;
    previewStream.current?.getTracks().forEach((track) => track.stop());
    previewStream.current = undefined;
    if (video.current) video.current.srcObject = null;
  }

  async function processUpc(upc: string, tone: "success" | "warn" | "error" = "success") {
    const trimmed = upc.trim();
    if (!trimmed || isProcessing.current) return;
    isProcessing.current = true;
    stopCamera();
    playScanFeedback(tone);
    setStatus("Saving…");
    try {
      await onUpc(trimmed);
    } finally {
      isProcessing.current = false;
      if (isMounted.current && !paused && !busy) {
        setStatus("Scanning…");
      }
    }
  }

  async function startBarcodeCamera(gen: number) {
    if (isProcessing.current || controls.current || paused || busy) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setCameraBlocked(true);
      setStatus("Live camera needs HTTPS or localhost. Enter the UPC manually below.");
      return;
    }
    setCameraBlocked(false);
    try {
      const reader = new BrowserMultiFormatReader();
      const next = await reader.decodeFromVideoDevice(undefined, video.current!, async (result) => {
        if (!result || cameraGen.current !== gen || isProcessing.current) return;
        await processUpc(result.getText());
      });
      if (cameraGen.current !== gen) {
        next.stop();
        return;
      }
      controls.current = next;
      if (isMounted.current) setStatus(statusHint ?? "Scanning…");
    } catch (error) {
      if (cameraGen.current !== gen) return;
      setCameraBlocked(true);
      setStatus(error instanceof Error ? error.message : "Camera unavailable. Enter the UPC manually below.");
    }
  }

  async function submitManual(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = manualUpc.trim();
    if (!trimmed) return;
    setManualUpc("");
    await processUpc(trimmed);
  }

  async function photo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setStatus("Reading the barcode…");
      const url = URL.createObjectURL(file);
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      URL.revokeObjectURL(url);
      await processUpc(result.getText());
    } catch {
      playScanFeedback("error");
      setStatus("No barcode in that photo. Try again or enter the UPC manually.");
    }
  }

  return (
    <section className="scan-session-scanner">
      <div className="chip-row" role="tablist" aria-label="What you are scanning">
        {IMPORT_KINDS.map((id) => (
          <button
            type="button"
            key={id}
            className={kind === id ? "chip active" : "chip"}
            onClick={() => onKindChange(id)}
            disabled={busy || isProcessing.current}
          >
            {IMPORT_KIND_LABELS[id]}
          </button>
        ))}
      </div>
      <div className={`camera-frame${cameraBlocked ? " camera-blocked" : ""}`}>
        <video ref={video} muted playsInline autoPlay />
        {!cameraBlocked && !paused && !busy && <span className="scan-session-target" aria-hidden="true" />}
      </div>
      <p className="scanner-status" aria-live="polite">{status}</p>
      <form className="scan-session-manual" onSubmit={(event) => void submitManual(event)}>
        <input
          value={manualUpc}
          onChange={(event) => setManualUpc(event.target.value.replace(/\D/g, "").slice(0, 14))}
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="Enter UPC manually"
          aria-label="Enter UPC manually"
          disabled={busy || isProcessing.current}
        />
        <button type="submit" className="secondary" disabled={!manualUpc.trim() || busy || isProcessing.current}>
          Add UPC
        </button>
      </form>
      <label className="secondary wide file-button">
        <Camera size={18}/> Snap a barcode photo
        <input type="file" accept="image/*" capture="environment" onChange={(event) => void photo(event)} disabled={busy || isProcessing.current}/>
      </label>
    </section>
  );
}
