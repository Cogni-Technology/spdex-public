/**
 * The "I bought" card: a dialog to caption a buy, preview it, and save it
 * as a PNG, copy it to paste straight into a post, or hand it to the
 * phone's share sheet. Nothing is uploaded.
 *
 * What the card may and may not say is lib/culture/card.ts's business; this
 * places it. The preview is the card itself: the PNG is this mounted `<svg>`,
 * drawn onto a canvas, so what is saved is what was seen, and React has
 * escaped the caption on the way in.
 *
 * The two warnings under the buttons are not boilerplate. A hash leads to the
 * wallet that made it, and a posted buy is exactly what scammers answer with
 * offers of "help".
 */

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { useModal } from "../useModal.js";
import { Button, ModeSwitch } from "@spdex/ui";
import type { RecordRow } from "../../lib/records/types.js";
import {
  CAPTION_PRESETS,
  CARD_FONTS,
  CARD_HEIGHT,
  CARD_PALETTES,
  CARD_WIDTH,
  MAX_CAPTION,
  canShareFiles,
  cardFileName,
  cardPng,
  cardTips,
  loadCardFonts,
  cardText,
  fittedSize,
  tippedText,
  type CardPalette,
  type CardText,
} from "../../lib/culture/card.js";
import { canCard } from "../../lib/culture/stack.js";
import { canCopyImage, copyPng } from "../../lib/clipboard.js";
import { downloadBlob } from "../../lib/download.js";
import { themeStore, type Theme } from "../../lib/theme.js";
import "./culture.css";

export interface IBoughtCardProps {
  row: RecordRow;
  chainId: number;
  /** Where this release is published (`shareableAppUrl()`), or null when the build doesn't say. */
  appUrl: string | null;
  onClose(): void;
  /** The colours to start in; the page's current mode when not given. */
  initialMode?: Theme;
}

type CaptionChoice = (typeof CAPTION_PRESETS)[number] | "own";

const MODE_OPTIONS: readonly { value: Theme; label: string }[] = [
  { value: "neon", label: "Neon" },
  { value: "pastel", label: "Pastel" },
];

export function IBoughtCard({ row, appUrl, onClose, initialMode }: IBoughtCardProps): JSX.Element | null {
  const [choice, setChoice] = useState<CaptionChoice>("Stacked");
  const [own, setOwn] = useState("");
  const [mode, setMode] = useState<Theme>(() => initialMode ?? themeStore().get());
  const [showAddress, setShowAddress] = useState(false);
  const [showCount, setShowCount] = useState(true);
  const [showTips, setShowTips] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shareable] = useState(() => canShareFiles());
  const [copyable] = useState(() => canCopyImage());
  // The card as it was when copied: "Copied." goes once the card changes.
  const [copiedAs, setCopiedAs] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Modal as the Features dialog is: focus kept inside, the page behind held
  // still, Escape to close, and focus back on "Make a card" afterwards.
  useModal(dialogRef, onClose);
  // The faces the PNG embeds, read as the dialog opens so saving doesn't wait
  // on them (lib/culture/card.ts, `loadCardFonts`).
  useEffect(() => {
    void loadCardFonts();
  }, []);

  if (!canCard(row)) return null;

  const caption = choice === "own" ? own : choice;
  const text = cardText(row, { caption, showAddress, showCount, showTips }, appUrl);
  const drawn = JSON.stringify([caption, mode, showAddress, showCount, showTips]);
  const tips = cardTips(row);

  const png = async (): Promise<Blob | null> => {
    const svg = svgRef.current;
    if (!svg) return null;
    setBusy(true);
    setProblem(null);
    try {
      return await cardPng(svg);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    const blob = await png();
    if (blob) downloadBlob(cardFileName(row), blob);
  };

  // Asked for in the click itself, with the picture still being drawn: the
  // clipboard is allowed only inside the gesture (lib/clipboard.ts, `copyPng`).
  const copy = () => {
    setCopiedAs(null);
    const picture = png().then((blob) => blob ?? Promise.reject(new Error("The card couldn't be drawn.")));
    copyPng(picture).then(
      () => setCopiedAs(drawn),
      // A drawing that failed has said why already (`png`).
      () => setProblem((said) => said ?? "This browser wouldn't put the card on the clipboard. Download it instead."),
    );
  };

  const share = async () => {
    const blob = await png();
    if (!blob) return;
    try {
      await navigator.share({ files: [new File([blob], cardFileName(row), { type: "image/png" })] });
    } catch (error) {
      // Closing the share sheet is a choice, not a failure.
      if (!(error instanceof DOMException && error.name === "AbortError")) setProblem("The share sheet couldn't take the card. Download it instead.");
    }
  };

  return (
    <div className="spdex-modal__backdrop" onClick={onClose}>
      <div
        className="spdex-modal spdex-card-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Make a card"
        data-testid="card-dialog"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="spdex-modal__head">
          <h2 className="spdex-modal__title">Make a card</h2>
          <button type="button" className="spdex-modal__close" data-testid="card-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="spdex-modal__body">
          <div className="spdex-card__preview" data-testid="card-preview">
            <CardSvg text={text} palette={CARD_PALETTES[mode]} svgRef={svgRef} />
          </div>

          <div className="spdex-card__controls">
            <fieldset className="spdex-card__group">
              <legend className="spdex-field__label">Caption</legend>
              <div className="spdex-presets__chips">
                {[...CAPTION_PRESETS, "own" as const].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="spdex-presets__chip"
                    aria-pressed={choice === value}
                    data-testid={`card-caption-${value.toLowerCase()}`}
                    onClick={() => setChoice(value)}
                  >
                    {value === "own" ? "Your own" : value}
                  </button>
                ))}
              </div>
              {choice === "own" ? (
                <input
                  className="spdex-input spdex-card__caption"
                  maxLength={MAX_CAPTION}
                  value={own}
                  placeholder={`Up to ${MAX_CAPTION} characters`}
                  aria-label="Your caption"
                  data-testid="card-caption-input"
                  onChange={(event) => setOwn(event.target.value)}
                />
              ) : null}
            </fieldset>

            <div className="spdex-card__group">
              <ModeSwitch label="Colours" groupLabel="Card colours" options={MODE_OPTIONS} value={mode} onChange={setMode} testId="card-mode" />
              <label className="spdex-card__check">
                <input type="checkbox" checked={showAddress} disabled={row.account === null} data-testid="card-address" onChange={(e) => setShowAddress(e.target.checked)} />
                <span>Print my address on the card (anyone with the hash can find it anyway)</span>
              </label>
              {row.buyIndex ? (
                <label className="spdex-card__check">
                  <input type="checkbox" checked={showCount} data-testid="card-count" onChange={(e) => setShowCount(e.target.checked)} />
                  <span>
                    Buy {row.buyIndex.n} of {row.buyIndex.of}
                  </span>
                </label>
              ) : null}
              {tips !== null ? (
                <label className="spdex-card__check">
                  <input type="checkbox" checked={showTips} data-testid="card-tips" onChange={(e) => setShowTips(e.target.checked)} />
                  <span>{tippedText(tips.people)}</span>
                </label>
              ) : null}
            </div>
          </div>

          {cardNotes(row, appUrl) === "" ? null : (
            <p className="spdex-field__hint" data-testid="card-link">
              {cardNotes(row, appUrl)}
            </p>
          )}

          <div className="spdex-actions spdex-card__actions">
            <Button testId="card-download" disabled={busy} onClick={() => void download()}>
              Download PNG
            </Button>
            {copyable ? (
              <Button variant="ghost" testId="card-copy" disabled={busy} onClick={copy}>
                Copy to clipboard
              </Button>
            ) : null}
            {shareable ? (
              <Button variant="ghost" testId="card-share" disabled={busy} onClick={() => void share()}>
                Share…
              </Button>
            ) : null}
          </div>
          {problem !== null ? (
            <p className="spdex-stack__error" role="alert" data-testid="card-problem">
              {problem}
            </p>
          ) : null}
          <p className="spdex-field__hint spdex-card__copied" role="status" data-testid="card-copied">
            {copiedAs === drawn && problem === null ? "Copied. Paste it into your post." : ""}
          </p>

          <ul className="spdex-card__warnings" data-testid="card-warnings">
            <li>The transaction hash lets anyone look up your address and everything it has done.</li>
            <li>
              Nobody from spDEX or SPX6900 will message you first. Anyone offering &ldquo;help&rdquo; after seeing your card
              wants your SPX.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * What the card leaves out, said only when it does: a link, when the build
 * names no address for spDEX; every transaction but the last; tips it has no
 * room for. The link itself is on the card, so it isn't said again.
 */
function cardNotes(row: RecordRow, appUrl: string | null): string {
  return [
    appUrl === null
      ? "This build doesn't say where spDEX is published, so the card has no link: it asks people to open #receipt= in any copy of spDEX, or to use a block explorer."
      : "",
    row.hashes.length > 1 ? `This buy took ${row.hashes.length} transactions; the card carries the last, the one that delivered the SPX.` : "",
    tipsLeftOff(row).trim(),
  ]
    .filter((note) => note !== "")
    .join(" ");
}

/** Why a swap sent with tips has no tips line: rare, so said only then. */
function tipsLeftOff(row: RecordRow): string {
  if (row.tips === undefined || cardTips(row) !== null) return "";
  return row.tips.hashes.length > 1
    ? ` Your tips went in ${row.tips.hashes.length} transactions, and the card has room for one, so it leaves them off.`
    : " spDEX couldn't read how many people your tips paid, so the card leaves them off.";
}

// ─── The picture ──────────────────────────────────────────────────────────────

/** Where the card's content starts and ends, left to right, in the picture's pixels. */
const LEFT = 76;
const RIGHT = 1106;
const INNER = RIGHT - LEFT;

/**
 * The card as an SVG, `CARD_WIDTH` × `CARD_HEIGHT`, drawn only from `text`
 * and `palette`. Literal colours and font stacks throughout, and nothing that
 * refers outside the picture: it must look the same drawn as an image, where
 * the page's styles don't reach.
 */
export function CardSvg({
  text,
  palette: p,
  svgRef,
}: {
  text: CardText;
  palette: CardPalette;
  svgRef?: RefObject<SVGSVGElement | null>;
}): JSX.Element {
  const captionSize = fittedSize(text.caption.toUpperCase(), 760, 50, 0.95);
  const amountSize = fittedSize(text.amount, INNER, 156, 0.52);
  const checkSize = fittedSize(text.check, INNER, 22, 0.62);
  // With tips, the transaction block moves up to make a line for their hash.
  const y = text.tipsLine === null ? LAYOUT : LAYOUT_WITH_TIPS;
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
      width={CARD_WIDTH}
      height={CARD_HEIGHT}
      role="img"
      aria-label={`${text.caption}: ${text.amount}, ${text.meta}`}
      className="spdex-card__svg"
    >
      <defs>
        <pattern id="spdex-card-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.6" fill={p.ink} fillOpacity="0.09" />
        </pattern>
        <pattern id="spdex-card-hazard" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="14" height="28" fill={p.lime} />
          <rect x="14" width="14" height="28" fill={p.ink} />
        </pattern>
      </defs>

      <rect width={CARD_WIDTH} height={CARD_HEIGHT} fill={p.paper} />
      <rect width={CARD_WIDTH} height={CARD_HEIGHT} fill="url(#spdex-card-dots)" />

      {/* The card, on the masthead's two hard shadows: ink, then magenta. */}
      <rect x="58" y="52" width="1110" height="600" fill={p.magenta} />
      <rect x="48" y="42" width="1110" height="600" fill={p.ink} />
      <rect x="36" y="30" width="1110" height="600" fill={p.surface} stroke={p.ink} strokeWidth="5" />
      <rect x="38.5" y="32.5" width="1105" height="24" fill="url(#spdex-card-hazard)" />
      <line x1="36" y1="57" x2="1146" y2="57" stroke={p.ink} strokeWidth="5" />

      {/* spDEX's own wordmark, as text: never SPX6900's logo or art. */}
      <rect x="946" y="84" width="160" height="46" fill={p.ink} />
      <text x="1026" y="116" textAnchor="middle" fill={p.lime} fontFamily={CARD_FONTS.display} fontSize="24" fontWeight="900" letterSpacing="2">
        spDEX
      </text>

      <g transform={`rotate(-1.5 ${LEFT} 152)`}>
        <rect x={LEFT} y="84" width={captionWidth(text.caption, captionSize)} height="68" fill={p.lime} stroke={p.ink} strokeWidth="4" />
        <FitText x={LEFT + 22} y={118 + captionSize * 0.36} max={760} fill={p.ink} fontFamily={CARD_FONTS.display} fontSize={captionSize} fontWeight="900" letterSpacing="3">
          {text.caption.toUpperCase()}
        </FitText>
      </g>

      <FitText x={LEFT} y={300} max={INNER} fill={p.ink} fontFamily={CARD_FONTS.stat} fontSize={amountSize} letterSpacing="1" testId="card-amount">
        {text.amount}
      </FitText>
      <FitText x={LEFT} y={352} max={INNER} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="28" fontWeight="700">
        {text.meta}
      </FitText>
      {text.address !== null ? (
        <FitText x={LEFT} y={394} max={INNER} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="24">
          {`To ${text.address}`}
        </FitText>
      ) : null}

      <line x1={LEFT} y1={y.rule} x2={RIGHT} y2={y.rule} stroke={p.ink} strokeWidth="2" strokeDasharray="8 7" />
      <text x={LEFT} y={y.label} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="18" fontWeight="700" letterSpacing="3">
        TRANSACTION
      </text>
      <FitText x={LEFT} y={y.hash[0]} max={INNER} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="32" fontWeight="700">
        {text.hashLines[0]}
      </FitText>
      <FitText x={LEFT} y={y.hash[1]} max={INNER} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="32" fontWeight="700">
        {text.hashLines[1]}
      </FitText>
      {text.tipsLine !== null ? (
        <>
          <text x={LEFT} y={y.tips} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="18" fontWeight="700" letterSpacing="3">
            TIPS
          </text>
          <FitText
            x={LEFT + TIPS_INDENT}
            y={y.tips}
            max={INNER - TIPS_INDENT}
            fill={p.ink}
            fontFamily={CARD_FONTS.data}
            fontSize={fittedSize(text.tipsLine, INNER - TIPS_INDENT, 22, 0.62)}
            fontWeight="700"
            testId="card-tips-hash"
          >
            {text.tipsLine}
          </FitText>
        </>
      ) : null}

      <FitText x={LEFT} y={y.check} max={INNER} fill={p.ink} fontFamily={CARD_FONTS.data} fontSize={checkSize} fontWeight="700">
        {text.check}
      </FitText>
      <text x={LEFT} y="614" fill={p.ink} fontFamily={CARD_FONTS.data} fontSize="18">
        {text.explorer}
      </text>
      <text x={RIGHT} y="614" textAnchor="end" fill={p.ink} fillOpacity="0.72" fontFamily={CARD_FONTS.data} fontSize="16">
        {text.footer}
      </text>
    </svg>
  );
}

/** Where the lines under the dashed rule sit, top to bottom: the transaction, then the check. */
const LAYOUT = { rule: 424, label: 462, hash: [502, 542], tips: 0, check: 586 } as const;
/** The same with a line for the tips' hash, the rest moved up to make room. */
const LAYOUT_WITH_TIPS = { rule: 412, label: 446, hash: [484, 520], tips: 558, check: 590 } as const;
/** How far right of "TIPS" its hash starts. */
const TIPS_INDENT = 78;

/** The caption tile's width: the caption's likely width plus its padding, within the room beside the wordmark. */
function captionWidth(caption: string, size: number): number {
  return Math.min(820, Math.max(220, Math.round([...caption].length * size * 0.95 + 44)));
}

/**
 * SVG text that never runs past `max` pixels: set at its size, measured once
 * mounted, and squeezed to fit (`textLength`) only if the system's font came
 * out wider than the size allowed for. The squeeze is an attribute, so the
 * PNG, drawn from this same element, carries it too.
 */
function FitText({
  max,
  children,
  testId,
  ...attrs
}: {
  x: number;
  y: number;
  max: number;
  fill: string;
  fontFamily: string;
  fontSize: number | string;
  fontWeight?: string;
  letterSpacing?: string;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<SVGTextElement>(null);
  const [squeeze, setSqueeze] = useState<number | null>(null);
  useLayoutEffect(() => {
    setSqueeze(null);
  }, [children, attrs.fontSize, attrs.fontFamily]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (squeeze !== null || !element || typeof element.getComputedTextLength !== "function") return;
    if (element.getComputedTextLength() > max) setSqueeze(max);
  }, [squeeze, max, children]);
  return (
    <text
      ref={ref}
      data-testid={testId}
      {...attrs}
      {...(squeeze === null ? {} : { textLength: squeeze, lengthAdjust: "spacingAndGlyphs" })}
    >
      {children}
    </text>
  );
}

