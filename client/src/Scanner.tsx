import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  IMPORT_KIND_LABELS,
  IMPORT_KINDS,
  LOOKUP_SOURCE_LABELS,
  lookupHasName,
  type ImportKind,
  type LookupResult,
  type LookupSource
} from "./catalog";

export type ScanResult = LookupResult & {
  product: Record<string, unknown>;
};

export type ScanReviewOutcome = "saved" | "cancelled" | "viewed";

type Props = {
  onProduct: (result: ScanResult) => Promise<ScanReviewOutcome>;
  onMiss: (result: ScanResult) => void;
};

export function sourceChipLabel(source: LookupSource) {
  return LOOKUP_SOURCE_LABELS[source] ?? source;
}

function resultName(result: ScanResult) {
  const product = result.product ?? {};
  return String(product.name ?? product.product_name ?? product.product_name_en ?? "").trim();
}

export function Scanner({ onProduct, onMiss }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | undefined>(undefined);
  const previewStream = useRef<MediaStream | undefined>(undefined);
  const cameraGen = useRef(0);
  const isProcessing = useRef(false);
  const isMounted = useRef(true);
  const [kind, setKind] = useState<ImportKind>("spirits");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Point the camera at a UPC");

  useEffect(() => () => {
    isMounted.current = false;
    stopCamera();
  }, []);

  useEffect(() => {
    const gen = ++cameraGen.current;
    isProcessing.current = false;
    setBusy(false);
    stopCamera();
    setStatus("Point the camera at a UPC");
    void startBarcodeCamera(gen);
    return () => {
      cameraGen.current += 1;
      stopCamera();
    };
  }, [kind]);

  function stopCamera() {
    controls.current?.stop();
    controls.current = undefined;
    previewStream.current?.getTracks().forEach((track) => track.stop());
    previewStream.current = undefined;
    if (video.current) video.current.srcObject = null;
  }

  function playSuccessDing() {
    try {
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.08);
      gain.gain.setValueAtTime(0.16, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
      oscillator.addEventListener("ended", () => void context.close());
    } catch {
      // Audio feedback is optional when browser autoplay policy blocks it.
    }
  }

  async function startBarcodeCamera(gen: number) {
    if (isProcessing.current || controls.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setStatus("Live camera needs HTTPS or localhost. Snap a photo of the barcode instead.");
      return;
    }
    try {
      const reader = new BrowserMultiFormatReader();
      const next = await reader.decodeFromVideoDevice(undefined, video.current!, async (result) => {
        if (!result) return;
        if (cameraGen.current !== gen) return;
        if (isProcessing.current) return;
        isProcessing.current = true;
        setBusy(true);
        controls.current?.stop();
        controls.current = undefined;
        playSuccessDing();
        await lookupAndReview(result.getText());
        isProcessing.current = false;
        if (isMounted.current) setBusy(false);
      });
      if (cameraGen.current !== gen) {
        next.stop();
        return;
      }
      controls.current = next;
      setStatus("Scanning…");
    } catch (error) {
      if (cameraGen.current !== gen) return;
      setStatus(error instanceof Error ? error.message : "Camera unavailable. Snap a photo of the barcode instead.");
    }
  }

  async function lookupAndReview(upc: string) {
    setStatus("Looking that up…");
    try {
      const data = await api<ScanResult>(`/lookup/barcode?code=${encodeURIComponent(upc)}&kind=${encodeURIComponent(kind)}`);
      const code = data.upc ?? upc;
      const hasName = lookupHasName(data.product) || Boolean(resultName(data));
      if (!isMounted.current) return;
      const payload: ScanResult = {
        ...data,
        upc: code,
        kind: data.kind ?? kind,
        product: data.product ?? { upc: code }
      };
      if (data.reason || data.source === "not_found" || !hasName) {
        setStatus(data.reason === "quota" ? "Lookup paused." : "Needs review.");
        onMiss(payload);
        return;
      }
      setStatus(`Found in ${sourceChipLabel(data.source)}. Opening…`);
      await onProduct(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not look that up";
      setStatus(message);
      if (isMounted.current) {
        onMiss({
          source: "not_found",
          upc,
          kind,
          product: { upc, name: "" },
          reason: "no_catalog",
          message
        });
      }
    }
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
      if (isProcessing.current) return;
      isProcessing.current = true;
      setBusy(true);
      playSuccessDing();
      await lookupAndReview(result.getText());
      isProcessing.current = false;
      if (isMounted.current) setBusy(false);
    } catch {
      setStatus("No barcode in that photo. Get closer, or review it as a miss.");
    }
  }

  return (
    <section className="scan-stage">
      <div className="chip-row" role="tablist" aria-label="What you are scanning">
        {IMPORT_KINDS.map((id) => (
          <button type="button" key={id} className={kind === id ? "chip active" : "chip"} onClick={() => setKind(id)} disabled={busy}>
            {IMPORT_KIND_LABELS[id]}
          </button>
        ))}
      </div>
      <div className="camera-frame">
        <video ref={video} muted playsInline autoPlay />
      </div>
      <p className="scanner-hint">
        One scan opens the bottle. Mixers skip the catalogs. Beer uses vault, cache, Open Food Facts, then COLA last. Label + Catalog.beer on a miss.
      </p>
      <label className="secondary wide file-button">
        <Camera size={18}/> Snap a barcode photo
        <input type="file" accept="image/*" capture="environment" onChange={photo} disabled={busy}/>
      </label>
      <p className="scanner-status">{status}</p>
    </section>
  );
}
