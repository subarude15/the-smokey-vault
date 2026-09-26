import "./brew-sheet-document.css";
import { brewSheetModel, type BrewSheetWaterChemistry, type SheetPair, type SheetTable } from "./brew-sheet-document";

/** Canonical Smokey Barrel brew sheet. Preview and PDF export both render this. */
export function BrewSheetDocument({ recipe }: { recipe: unknown }) {
  const sheet = brewSheetModel(recipe);
  const meta = [sheet.style, sheet.system, sheet.fermenter].filter(Boolean);
  const showFermentation = Boolean(
    sheet.yeast || sheet.fermentationFields.length || sheet.fermentationLines.length || sheet.fermentationSteps || sheet.packagingFields.length || sheet.packagingSteps.length
  );
  const left = Boolean(sheet.fermentables || sheet.kettle || sheet.whirlpool);
  const right = Boolean(sheet.dryHops.length || showFermentation);
  const showWater = Boolean(sheet.waterChemistry || sheet.water.length);

  return (
    <article className="brew-doc">
      <header className="brew-doc-header">
        <div>
          <p className="brew-doc-brewery">Smokey Barrel Brewery</p>
          {sheet.beerName && <h1>{sheet.beerName}</h1>}
          {meta.length > 0 && <p className="brew-doc-meta">{meta.join(" · ")}</p>}
        </div>
        <p className="brew-doc-mark">Brew Sheet</p>
      </header>
      <hr className="brew-doc-rule"/>
      {sheet.warnings.length > 0 && (
        <section className="brew-doc-warnings" aria-label="Critical warnings">
          <strong>Critical warnings</strong>
          <ul>
            {sheet.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
          </ul>
        </section>
      )}
      {sheet.stats.length > 0 && (
        <section className="brew-doc-stats" aria-label="Vital statistics">
          {sheet.stats.map((stat) => (
            <div key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              {stat.writeIn && <em>{stat.writeIn} ________</em>}
            </div>
          ))}
        </section>
      )}
      {showWater && (
        <section className="brew-doc-water" aria-label="Water and mash">
          <h2>Water / mash profile</h2>
          {sheet.waterChemistry ? <WaterChemistryBlock chemistry={sheet.waterChemistry}/> : null}
          {sheet.water.length > 0 && (
            <dl className="brew-doc-water-extra">
              {sheet.water.map((pair) => (
                <div key={pair.label}>
                  <dt>{pair.label}</dt>
                  <dd>{pair.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      )}
      {(left || right) && (
        <div className={left && right ? "brew-doc-split" : "brew-doc-stack"}>
          {left && (
            <div>
              {sheet.fermentables && <Section number="1" title="Grist & fermentables" table={sheet.fermentables}/>}
              {(sheet.kettle || sheet.whirlpool) && (
                <section className="brew-doc-section">
                  <h2><span>2</span>Kettle & whirlpool</h2>
                  {sheet.kettle && <SheetTableView caption="Kettle" table={sheet.kettle}/>}
                  {sheet.whirlpool && <SheetTableView caption="Whirlpool" table={sheet.whirlpool}/>}
                </section>
              )}
            </div>
          )}
          {right && (
            <div>
              {sheet.dryHops.length > 0 && (
                <section className="brew-doc-section">
                  <h2><span>3</span>Dry hops</h2>
                  {sheet.dryHops.map((block) => (
                    <div className="brew-doc-stage" key={block.stage}>
                      <h3>{block.stage}</h3>
                      <SheetTableView table={block.table}/>
                    </div>
                  ))}
                </section>
              )}
              {showFermentation && (
                <section className="brew-doc-section">
                  <h2><span>4</span>Yeast & fermentation</h2>
                  {sheet.yeast && <p className="brew-doc-yeast">{sheet.yeast}</p>}
                  {sheet.fermentationFields.length > 0 && <PairList pairs={sheet.fermentationFields}/>}
                  {sheet.fermentationLines.map((line) => <p key={line}>{line}</p>)}
                  {sheet.fermentationSteps && <SheetTableView caption="Schedule" table={sheet.fermentationSteps}/>}
                  {(sheet.packagingFields.length > 0 || sheet.packagingSteps.length > 0) && (
                    <div className="brew-doc-pack">
                      <h3>Packaging</h3>
                      <PairList pairs={sheet.packagingFields}/>
                      {sheet.packagingSteps.map((step) => <p key={step}>{step}</p>)}
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      )}
      {(sheet.checklist.length > 0 || sheet.measurements.length > 0) && (
        <section className="brew-doc-section">
          <h2><span>5</span>Brewday checklist & measurements</h2>
          {sheet.checklist.length > 0 && (
            <ul className="brew-doc-checks">
              {sheet.checklist.map((item) => (
                <li key={item}><span className="brew-doc-box" aria-hidden="true"/>{item}</li>
              ))}
            </ul>
          )}
          {sheet.measurements.length > 0 && (
            <ul className="brew-doc-measures">
              {sheet.measurements.map((label) => (
                <li key={label}><span>{label}</span><span className="brew-doc-line"/></li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="brew-doc-section brew-doc-notes">
        <h2><span>6</span>Brewer notes</h2>
        {sheet.notes && <p>{sheet.notes}</p>}
        <div className="brew-doc-pad" aria-hidden="true"/>
      </section>
    </article>
  );
}

function WaterChemistryBlock({ chemistry }: { chemistry: BrewSheetWaterChemistry }) {
  return (
    <div className="brew-doc-chem">
      <dl className="brew-doc-chem-meta">
        <div>
          <dt>Source</dt>
          <dd>{chemistry.source}</dd>
        </div>
        {chemistry.volumes.map((pair) => (
          <div key={pair.label}>
            <dt>{pair.label}</dt>
            <dd>{pair.value}</dd>
          </div>
        ))}
      </dl>
      {chemistry.targetProfile.length > 0 && (
        <div className="brew-doc-chem-block">
          <h3>Target mineral profile</h3>
          <dl className="brew-doc-chem-ions">
            {chemistry.targetProfile.map((pair) => (
              <div key={`target-${pair.label}`}>
                <dt>{pair.label}</dt>
                <dd>{pair.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {chemistry.saltTable && (
        <div className="brew-doc-chem-block">
          <h3>Salt additions</h3>
          <SheetTableView table={chemistry.saltTable}/>
        </div>
      )}
      {chemistry.achievedProfile.length > 0 && (
        <div className="brew-doc-chem-block">
          <h3>Achieved profile</h3>
          <dl className="brew-doc-chem-ions">
            {chemistry.achievedProfile.map((pair) => (
              <div key={`achieved-${pair.label}`}>
                <dt>{pair.label}</dt>
                <dd>{pair.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {chemistry.statusMessage && <p className="brew-doc-chem-status">{chemistry.statusMessage}</p>}
      <div className="brew-doc-chem-block brew-doc-mash-ph">
        <h3>Mash pH</h3>
        <dl className="brew-doc-chem-meta">
          <div>
            <dt>Target</dt>
            <dd>{chemistry.mashPh.target}</dd>
          </div>
          <div>
            <dt>88% Lactic Acid</dt>
            <dd>{chemistry.mashPh.lactic}</dd>
          </div>
          {chemistry.mashPh.measuredWriteIn && (
            <div>
              <dt>Measured pH</dt>
              <dd className="brew-doc-writein">__________</dd>
            </div>
          )}
        </dl>
        {chemistry.mashPh.note && <p className="brew-doc-chem-note">{chemistry.mashPh.note}</p>}
      </div>
    </div>
  );
}

function Section({ number, title, table }: { number: string; title: string; table: SheetTable }) {
  return (
    <section className="brew-doc-section">
      <h2><span>{number}</span>{title}</h2>
      <SheetTableView table={table}/>
    </section>
  );
}

function SheetTableView({ caption, table }: { caption?: string; table: SheetTable }) {
  return (
    <table>
      {caption && <caption>{caption}</caption>}
      <thead>
        <tr>{table.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={index}>{row.map((cell, cellIndex) => <td key={table.columns[cellIndex] ?? cellIndex}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function PairList({ pairs }: { pairs: SheetPair[] }) {
  if (!pairs.length) return null;
  return (
    <dl className="brew-doc-pairs">
      {pairs.map((pair) => (
        <div key={pair.label}>
          <dt>{pair.label}</dt>
          <dd>{pair.value}</dd>
        </div>
      ))}
    </dl>
  );
}
