import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera, ScanBarcode, ScanText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export type ScanResult = {
  source: "vault" | "cache" | "cola_cloud" | "openfoodfacts" | "upcitemdb" | "ai" | "vision" | "unresolved" | "not_found";
  upc?: string;
  table?: "spirits" | "packaged_beer" | "wines";
  product: Record<string, unknown>;
  message?: string;
  quota?: {
    detail_views_remaining?: string | null;
    list_records_remaining?: string | null;
    quota_reset?: string | null;
  };
};

export type ScanReviewOutcome = "saved" | "cancelled" | "viewed";
type Mode = "barcode" | "label";
type Props = {
  onProduct: (result: ScanResult) => Promise<ScanReviewOutcome>;
  onMiss: (upc: string) => void;
};

function sourceLabel(source: ScanResult["source"]) {
  if (source === "cola_cloud") return "COLA";
  if (source === "cache") return "a saved lookup";
  if (source === "openfoodfacts" || source === "upcitemdb") return "the catalog";
  if (source === "vault") return "the vault";
  if (source === "vision") return "the label";
  if (source === "not_found") return "no match";
  return source;
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
  const [mode, setMode] = useState<Mode>("barcode");
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
    if (mode === "barcode") {
      setStatus("Point the camera at a UPC");
      void startBarcodeCamera(gen);
    } else {
      setStatus("Line up the front label, then tap Scan label");
      void startLabelPreview(gen);
    }
    return () => {
      cameraGen.current += 1;
      stopCamera();
    };
  }, [mode]);

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

  async function startLabelPreview(gen = cameraGen.current) {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setStatus("Live camera needs HTTPS or localhost. Take a photo of the label instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } }
      });
      if (!isMounted.current || cameraGen.current !== gen) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      previewStream.current = stream;
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play().catch(() => undefined);
      }
      setStatus("Line up the front label, then tap Scan label");
    } catch (error) {
      if (cameraGen.current !== gen) return;
      setStatus(error instanceof Error ? error.message : "Camera unavailable. Take a photo of the label instead.");
    }
  }

  async function lookupAndReview(upc: string) {
    setStatus("Looking that up…");
    try {
      const data = await api<ScanResult>(`/scan/upc/${encodeURIComponent(upc)}`);
      const code = data.upc ?? upc;
      const hasName = Boolean(resultName(data));
      if (!isMounted.current) return;
      if (data.source === "not_found" || data.source === "unresolved" || !hasName) {
        setStatus("No match. Search by name — we’ll keep this UPC.");
        onMiss(code);
        return;
      }
      const label = sourceLabel(data.source);
      setStatus(`Found in ${label}. Opening…`);
      await onProduct({
        ...data,
        upc: code,
        product: data.product ?? { upc: code }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not look that up";
      setStatus(`${message}. Search by name — we’ll keep this UPC.`);
      if (isMounted.current) onMiss(upc);
    }
  }

  async function readLabel(file: Blob) {
    isProcessing.current = true;
    setBusy(true);
    setStatus("Reading the label…");
    stopCamera();
    try {
      const body = new FormData();
      body.append("image", file, "label.jpg");
      const data = await api<ScanResult>("/ai/vision", { method: "POST", body });
      const product = data.product ?? {};
      const code = String(data.upc ?? product.upc ?? "").trim();
      if (!isMounted.current) return;
      if (!resultName({ ...data, product })) {
        setStatus("Couldn’t read a name. Search by name, or try the label again.");
        onMiss(code);
        return;
      }
      playSuccessDing();
      setStatus("Found on the label. Opening…");
      await onProduct({
        source: "vision",
        upc: code || undefined,
        product: { ...product, upc: code || product.upc }
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read that label");
      isProcessing.current = false;
      setBusy(false);
      if (isMounted.current && mode === "label") void startLabelPreview();
      return;
    }
    isProcessing.current = false;
    if (isMounted.current) setBusy(false);
  }

  async function captureLabel() {
    if (busy || isProcessing.current) return;
    const node = video.current;
    if (!node || node.readyState < 2 || !node.videoWidth) {
      setStatus("Camera isn’t ready yet. Wait a beat, or take a photo instead.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = node.videoWidth;
    canvas.height = node.videoHeight;
    canvas.getContext("2d")?.drawImage(node, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) {
      setStatus("Could not grab that frame. Take a photo instead.");
      return;
    }
    playSuccessDing();
    await readLabel(blob);
  }

  async function photo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (mode === "label") {
      await readLabel(file);
      return;
    }
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
      setStatus("No barcode in that photo. Get closer, or try the Label tab.");
    }
  }

  return (
    <section className="scan-stage">
      <div className="scan-tabs" role="tablist" aria-label="Scan method">
        <button type="button" role="tab" aria-selected={mode === "barcode"} className={mode === "barcode" ? "active" : ""} onClick={() => setMode("barcode")} disabled={busy}>
          <ScanBarcode size={18}/> Barcode
        </button>
        <button type="button" role="tab" aria-selected={mode === "label"} className={mode === "label" ? "active" : ""} onClick={() => setMode("label")} disabled={busy}>
          <ScanText size={18}/> Label
        </button>
      </div>
      <div className={`camera-frame${mode === "label" ? " label-frame" : ""}`}>
        <video ref={video} muted playsInline autoPlay />
      </div>
      <p className="scanner-hint">
        {mode === "barcode"
          ? "One scan opens the bottle, or search if we don’t know it yet."
          : "We’ll read the name from the front of the bottle, then take you to the details."}
      </p>
      {mode === "label" && (
        <button type="button" className="primary wide scan-shutter" onClick={() => void captureLabel()} disabled={busy}>
          <ScanText size={18}/> {busy ? "Reading…" : "Scan label"}
        </button>
      )}
      <label className="secondary wide file-button">
        <Camera size={18}/> {mode === "label" ? "Use a photo instead" : "Snap a barcode photo"}
        <input type="file" accept="image/*" capture="environment" onChange={photo} disabled={busy}/>
      </label>
      <p className="scanner-status">{status}</p>
    </section>
  );
}
