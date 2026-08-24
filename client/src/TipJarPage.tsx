import { HandCoins, Smartphone, Sparkles } from "lucide-react";
import { QrCode, QrTipCard } from "./QrCode";
import { DEFAULT_HOUSE_TIP_BLURB, appleCashLink, tipHandles } from "./catalog";

export type HouseSettings = Record<string, string>;

export function TipJarPage({ settings, keeperName }: { settings: HouseSettings; keeperName: string }) {
  const blurb = settings.house_tip_blurb?.trim() || DEFAULT_HOUSE_TIP_BLURB;
  const houseHandles = tipHandles(settings);
  const bartenderOn = settings.guest_bartender_enabled === "1";
  const bartenderName = settings.guest_bartender_name?.trim() || "Tonight's guest bartender";
  const bartenderHandles = tipHandles({
    tip_venmo: settings.guest_bartender_venmo,
    tip_cashapp: settings.guest_bartender_cashapp,
    tip_paypal: settings.guest_bartender_paypal
  });
  const appleCash = appleCashLink(settings.guest_bartender_applecash ?? "", `Apple Cash tip for ${bartenderName}`);

  return <>
    <div className="page-title">
      <span className="eyebrow">THE TIP JAR</span>
      <h1>Drinks are on the house.</h1>
      <p>{blurb}</p>
    </div>

    {bartenderOn && <section className="bartender-card">
      <div className="bartender-portrait">
        {settings.guest_bartender_photo ? <img src={settings.guest_bartender_photo} alt={bartenderName}/> : <Sparkles size={40}/>}
      </div>
      <div className="bartender-body">
        <span className="eyebrow">BEHIND THE STICK TONIGHT</span>
        <h2>{bartenderName}</h2>
        {settings.guest_bartender_bio ? <p>{settings.guest_bartender_bio}</p> : null}
        <div className="tip-handle-row">
          {appleCash && <div className="tip-handle apple-cash">
            <a className="tip-handle-link" href={appleCash}>
              <strong><Smartphone size={16}/> Apple Cash</strong>
              <span>{settings.guest_bartender_applecash}</span>
            </a>
            <QrCode value={appleCash} size={116} label="Scan to open Messages"/>
          </div>}
          {bartenderHandles.map((handle) => (
            <QrTipCard key={handle.id} label={handle.label} hint={handle.hint} href={handle.href}/>
          ))}
        </div>
        {!appleCash && !bartenderHandles.length && <p className="field-hint">Ask {keeperName} how to tip tonight's bartender.</p>}
      </div>
    </section>}

    <section className="tip-jar-card">
      <div className="section-heading">
        <div>
          <span className="eyebrow">HOUSE TIP JAR</span>
          <h2><HandCoins size={22}/> Keep the kegs coming</h2>
        </div>
      </div>
      {houseHandles.length ? <div className="tip-handle-row">
        {houseHandles.map((handle) => (
          <QrTipCard key={handle.id} label={handle.label} hint={handle.hint} href={handle.href} note="Tap the card or scan the code"/>
        ))}
      </div> : <p className="field-hint">{keeperName} has not published tip handles yet. Add them in Admin → Settings.</p>}
    </section>
  </>;
}
