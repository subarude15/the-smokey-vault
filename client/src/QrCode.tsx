import { QRCodeSVG } from "qrcode.react";

/**
 * QR codes are drawn as inline SVG so a kiosk with no internet still shows a
 * scannable code. Nothing here fetches a remote image.
 */
export function QrCode({ value, size = 132, label }: { value: string; size?: number; label?: string }) {
  if (!value) return null;
  return (
    <figure className="qr-code">
      <QRCodeSVG value={value} size={size} level="M" bgColor="#ffffff" fgColor="#141414" marginSize={2}/>
      {label ? <figcaption>{label}</figcaption> : null}
    </figure>
  );
}

export function QrTipCard({ label, hint, href, note }: { label: string; hint: string; href: string; note?: string }) {
  return (
    <div className="tip-handle">
      <a className="tip-handle-link" href={href} target="_blank" rel="noreferrer">
        <strong>{label}</strong>
        <span>{hint}</span>
      </a>
      <QrCode value={href} size={116} label={`Scan for ${label}`}/>
      {note ? <small>{note}</small> : null}
    </div>
  );
}
