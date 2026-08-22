import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera, ScanBarcode, Sparkles } from "lucide-react";
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
type Props = { onProduct: (result: ScanResult) => Promise<ScanReviewOutcome> };

function sourceLabel(source: ScanResult["source"]) {
  if (source === "cola_cloud") return "COLA";
  if (source === "cache") return "a saved lookup";
  if (source === "openfoodfacts" || source === "upcitemdb") return "the catalog";
  if (source === "vault") return "the vault";
  if (source === "vision") return "the label photo";
  if (source === "not_found") return "no match";
  return source;
}

export function Scanner({ onProduct }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | undefined>(undefined);
  const isProcessing = useRef(false);
  const isMounted = useRef(true);
  const [mode, setMode] = useState<"barcode" | "vision">("barcode");
  const [status, setStatus] = useState("Point the camera at a UPC");

  useEffect(() => () => {
    isMounted.current = false;
    controls.current?.stop();
  }, []);

  useEffect(() => {
    if (mode !== "barcode") {
      controls.current?.stop();
      controls.current = undefined;
      setStatus("Photograph the front label");
      return;
    }
    setStatus("Point the camera at a UPC");
    void startCamera();
    return () => {
      controls.current?.stop();
      controls.current = undefined;
    };
  }, [mode]);

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

  async function startCamera() {
    if (isProcessing.current || controls.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setStatus("Live camera needs HTTPS or localhost. Snap a photo of the barcode instead.");
      return;
    }
    try {
      const reader = new BrowserMultiFormatReader();
      controls.current = await reader.decodeFromVideoDevice(undefined, video.current!, async (result) => {
        if (!result) return;
        if (isProcessing.current) return;
        isProcessing.current = true;
        controls.current?.stop();
        controls.current = undefined;
        playSuccessDing();
        await lookupAndReview(result.getText());
        isProcessing.current = false;
        if (isMounted.current && mode === "barcode") void startCamera();
      });
      setStatus("Scanning… one bottle at a time");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Camera unavailable. Snap a photo of the barcode instead.");
    }
  }

  async function lookupAndReview(upc: string) {
    setStatus("Looking that up…");
    try {
      const data = await api<ScanResult>(`/scan/upc/${encodeURIComponent(upc)}`);
      const hasName = Boolean(data.product?.name || data.product?.product_name);
      const label = sourceLabel(data.source);
      setStatus(hasName
        ? `Found in ${label}. Check the details, then save.`
        : `${data.message ?? "No match yet."} Fill in what you can, or search by name.`);
      const outcome = await onProduct({
        ...data,
        upc: data.upc ?? upc,
        product: data.product ?? { upc },
        source: data.source === "not_found" ? "not_found" : data.source
      });
      if (!isMounted.current) return;
      setStatus(outcome === "saved" ? "Saved. Next bottle."
        : outcome === "viewed" ? "That’s already in the vault. Next bottle."
        : "Skipped. Next bottle.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not look that up";
      setStatus(`${message}. You can still add it by hand.`);
      await onProduct({ source: "unresolved", upc, product: { upc } });
      if (!isMounted.current) return;
    }
  }

  async function photo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (mode === "vision") {
      const body = new FormData();
      body.append("image", file);
      setStatus("Reading the front label…");
      try {
        const data = await api<{ result: string }>("/ai/vision", { method: "POST", body });
        const json = JSON.parse(data.result.replace(/```json|```/g, "").trim());
        const outcome = await onProduct({ source: "vision", product: json });
        if (!isMounted.current) return;
        setStatus(outcome === "saved" ? "Saved. Next bottle." : "Skipped. Next bottle.");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not read that label");
      }
      return;
    }
    try {
      setStatus("Reading the barcode…");
      const url = URL.createObjectURL(file);
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      URL.revokeObjectURL(url);
      if (isProcessing.current) return;
      isProcessing.current = true;
      playSuccessDing();
      await lookupAndReview(result.getText());
      isProcessing.current = false;
    } catch {
      setStatus("No barcode in that photo. Get closer, or try Front label.");
    }
  }

  return (
    <section className="scan-stage">
      <div className="segmented">
        <button type="button" className={mode === "barcode" ? "active" : ""} onClick={() => setMode("barcode")}><ScanBarcode size={18}/> Barcode</button>
        <button type="button" className={mode === "vision" ? "active" : ""} onClick={() => setMode("vision")}><Sparkles size={18}/> Front label</button>
      </div>
      {mode === "barcode" && (
        <>
          <div className="camera-frame"><video ref={video} muted playsInline /></div>
          <p className="scanner-hint">It pauses after each hit so you can review, then comes back for the next one.</p>
        </>
      )}
      {mode === "vision" && (
        <div className="vision-card">
          <Sparkles size={32}/>
          <h3>No barcode? Snap the front.</h3>
          <p>We’ll read the name, brand, and ABV from the label. You still review before it hits the shelf.</p>
        </div>
      )}
      <label className="secondary wide file-button">
        <Camera size={18}/> {mode === "vision" ? "Take label photo" : "Snap a barcode photo"}
        <input type="file" accept="image/*" capture="environment" onChange={photo}/>
      </label>
      <p className="scanner-status">{status}</p>
    </section>
  );
}
