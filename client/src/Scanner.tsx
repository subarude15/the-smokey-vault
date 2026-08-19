import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera, ScanBarcode, Sparkles, X } from "lucide-react";
import { api } from "./api";

export type ScanResult = {
  source: "vault" | "openfoodfacts" | "upcitemdb" | "ai" | "vision" | "unresolved";
  upc?: string;
  table?: "spirits" | "packaged_beer";
  product: Record<string, unknown>;
};

export type ScanReviewOutcome = "saved" | "cancelled";
type Props = { onClose: () => void; onProduct: (result: ScanResult) => Promise<ScanReviewOutcome> };

export function Scanner({ onClose, onProduct }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls>();
  const isProcessing = useRef(false);
  const isMounted = useRef(true);
  const [mode, setMode] = useState<"barcode" | "vision">("barcode");
  const [status, setStatus] = useState("Point the camera at a UPC barcode");

  useEffect(() => () => {
    isMounted.current = false;
    controls.current?.stop();
  }, []);

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
      setStatus("Camera streaming requires HTTPS or localhost. Use photo capture below.");
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
      setStatus("Scanning… one item at a time");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Camera unavailable");
    }
  }

  async function lookupAndReview(upc: string) {
    setStatus(`Looking up ${upc}…`);
    try {
      const data = await api<ScanResult>(`/scan/upc/${upc}`);
      setStatus("Review this item to continue scanning.");
      const outcome = await onProduct(data);
      setStatus(outcome === "saved" ? "Saved. Ready for the next bottle." : "Cancelled. Ready for the next bottle.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Product not found";
      setStatus(message === "Product not found" ? "No catalog match. Add the item details manually." : `${message}. Review the UPC manually.`);
      await onProduct({ source: "unresolved", upc, product: {} });
    }
  }

  async function photo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (mode === "vision") {
      const body = new FormData();
      body.append("image", file);
      setStatus("Reading the bottle label…");
      try {
        const data = await api<{ result: string }>("/ai/vision", { method: "POST", body });
        const json = JSON.parse(data.result.replace(/```json|```/g, "").trim());
        await onProduct({ source: "vision", product: json });
        setStatus("Review complete");
      } catch (error) { setStatus(error instanceof Error ? error.message : "Could not read label"); }
      return;
    }
    try {
      setStatus("Reading barcode from photo…");
      const url = URL.createObjectURL(file);
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      URL.revokeObjectURL(url);
      if (isProcessing.current) return;
      isProcessing.current = true;
      playSuccessDing();
      await lookupAndReview(result.getText());
      isProcessing.current = false;
    } catch { setStatus("No barcode found. Try a closer, sharper photo."); }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal scanner-modal">
        <header className="modal-header">
          <div><span className="eyebrow">DUAL SCANNER</span><h2>Capture inventory</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X /></button>
        </header>
        <div className="segmented">
          <button className={mode === "barcode" ? "active" : ""} onClick={() => setMode("barcode")}><ScanBarcode size={18}/> UPC barcode</button>
          <button className={mode === "vision" ? "active" : ""} onClick={() => setMode("vision")}><Sparkles size={18}/> AI label</button>
        </div>
        {mode === "barcode" && (
          <>
            <div className="camera-frame"><video ref={video} muted playsInline /></div>
            <p className="scanner-hint">The camera pauses after each successful scan and resumes after review.</p>
            <button className="primary wide" onClick={startCamera}><Camera size={18}/> Start live camera</button>
          </>
        )}
        {mode === "vision" && <div className="vision-card"><Sparkles size={32}/><h3>Photograph the front label</h3><p>Your configured vision model extracts brand, name, category, and ABV.</p></div>}
        <label className="secondary wide file-button"><Camera size={18}/> {mode === "vision" ? "Take label photo" : "Capture / choose barcode photo"}<input type="file" accept="image/*" capture="environment" onChange={photo}/></label>
        <p className="scanner-status">{status}</p>
      </section>
    </div>
  );
}
