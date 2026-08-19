import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { Camera, ScanBarcode, Sparkles, X } from "lucide-react";
import { api } from "./api";

export type ScanResult = {
  source: "vault" | "openfoodfacts" | "vision" | "unresolved";
  upc?: string;
  table?: "spirits" | "packaged_beer";
  product: Record<string, unknown>;
};

type Props = { onClose: () => void; onProduct: (result: ScanResult) => void };

export function Scanner({ onClose, onProduct }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls>();
  const [mode, setMode] = useState<"barcode" | "vision">("barcode");
  const [status, setStatus] = useState("Point the camera at a UPC barcode");
  const [batch, setBatch] = useState(false);

  useEffect(() => () => controls.current?.stop(), []);

  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      setStatus("Camera streaming requires HTTPS or localhost. Use photo capture below.");
      return;
    }
    try {
      const reader = new BrowserMultiFormatReader();
      controls.current = await reader.decodeFromVideoDevice(undefined, video.current!, async (result) => {
        if (!result) return;
        await lookup(result.getText());
        if (!batch) controls.current?.stop();
      });
      setStatus(batch ? "Speedrun mode — keep scanning" : "Scanning…");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Camera unavailable");
    }
  }

  async function lookup(upc: string) {
    setStatus(`Looking up ${upc}…`);
    try {
      const data = await api<ScanResult>(`/scan/upc/${upc}`);
      onProduct(data);
      setStatus(batch ? "Saved result. Ready for the next barcode." : `Found ${upc}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Product not found";
      if (message === "Product not found") {
        onProduct({ source: "unresolved", upc, product: {} });
        setStatus("No catalog match. Add the item details manually.");
      } else {
        setStatus(message);
      }
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
        onProduct({ source: "vision", product: json });
        setStatus("Label recognized");
      } catch (error) { setStatus(error instanceof Error ? error.message : "Could not read label"); }
      return;
    }
    try {
      setStatus("Reading barcode from photo…");
      const url = URL.createObjectURL(file);
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      URL.revokeObjectURL(url);
      await lookup(result.getText());
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
            <label className="toggle"><input type="checkbox" checked={batch} onChange={(e) => setBatch(e.target.checked)} /><span /> Continuous speedrun mode</label>
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
