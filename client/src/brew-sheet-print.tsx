import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrewSheetDocument } from "./BrewSheetDocument";

function PrintPage() {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [recipe, setRecipe] = useState<unknown>(null);
  const [marker, setMarker] = useState<"pending" | "true" | "error">(token ? "pending" : "error");
  const [detail, setDetail] = useState(token ? "" : "missing token");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/brew-sheet-render/${encodeURIComponent(token)}`);
        if (!response.ok) throw new Error(`http ${response.status}`);
        const body = await response.json() as { recipe?: unknown };
        if (cancelled || body.recipe == null) throw new Error("empty");
        setRecipe(body.recipe);
        await document.fonts.ready;
        if (!cancelled) setMarker("true");
      } catch (error) {
        if (!cancelled) {
          setDetail(error instanceof Error ? error.message : "error");
          setMarker("error");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (marker === "error") return <p data-brew-sheet-ready="error" data-brew-sheet-detail={detail}>Brew sheet unavailable.</p>;
  if (!recipe) return null;
  return (
    <div className="brew-sheet-page" data-brew-sheet-ready={marker === "true" ? "true" : "false"}>
      <BrewSheetDocument recipe={recipe}/>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<PrintPage/>);
