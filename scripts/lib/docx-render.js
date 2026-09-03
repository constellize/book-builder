'use strict';

/**
 * docx-render.js — render a .docx to PDF with ZERO interactive prompts.
 *
 * Two engines, both empirically verified prompt-free on macOS:
 *
 *   libreoffice  headless, unsandboxed, ~0.8 s warm. The default, and the only
 *                engine usable in CI. Does NOT update field results, so a
 *                document whose TOC is a live { TOC } field renders with an
 *                empty TOC (measured: 0 dot-leader lines vs Word's 7).
 *
 *   word         the fidelity reference, ~1.5-2 s. Prompt-free only via the
 *                two defences below. Produces a correct, repaginated TOC.
 *
 * ---------------------------------------------------------------------------
 * THE TWO WORD PROMPTS, AND WHY THE DEFENCES ARE SHAPED THIS WAY
 * ---------------------------------------------------------------------------
 *
 * (A) "This document contains fields that may refer to other files. Do you
 *      want to update...?"
 *
 *     Trigger: Word's `Options.UpdateLinksAtOpen` preference is ON (the macOS
 *     default) and the document carries a field wanting update at open.
 *
 *     Not suppressible any other way. Measured, not guessed:
 *       - `display alerts` is irrelevant: it already defaults to `alerts none`
 *         on every launch, and the dialog appears under both `none` and `all`.
 *       - No AX/UI watcher can dismiss it. Word's main thread sits in a nested
 *         modal loop inside -[NSDocument initWithContentsOfURL:ofType:error:]
 *         and exposes ZERO accessibility windows while blocked.
 *       - `defaults write com.microsoft.Word ...` cannot reach the preference:
 *         it lives in the Office registration SQLite DB
 *         (~/Library/Group Containers/UBF8T346G9.Office/MicrosoftRegistrationDB.reg,
 *         HKEY_CURRENT_USER/.../Word/Options -> DontUpdateLinks REG_DWORD).
 *       - Stripping w:updateFields / w:dirty avoids the prompt only by making
 *         Word skip the update, which ships an EMPTY TOC.
 *
 *     Defence: flip the preference off for the duration of the run, update the
 *     fields explicitly instead (which is what the prompt was asking to do, so
 *     the TOC is still correct), then put the preference back. The original
 *     value is journalled to disk BEFORE the flip, so a crash or SIGKILL cannot
 *     strand the user's setting -- the next run detects the journal and
 *     restores it. Pass `allowPrefToggle: false` to refuse the flip entirely;
 *     the caller then gets a NEEDS_PREF error carrying the exact one-line
 *     instruction for the user.
 *
 * (B) "Microsoft Word would like to access files in <folder>."
 *
 *     This is the App Sandbox powerbox panel, NOT TCC. Word's entitlements are
 *     app-sandbox + files.user-selected.read-write + files.bookmarks.app-scope,
 *     with no home-relative read-write exception, so EVERY path outside
 *     ~/Library/Containers/com.microsoft.Word/Data/ needs an interactive grant
 *     (persisted in com.microsoft.Word.securebookmarks.plist). Confirmed by
 *     finding com.apple.appkit.xpc.openAndSavePanelService running as Word's
 *     child while a conversion was blocked.
 *
 *     Granting Full Disk Access does NOT help -- FDA is TCC, and App Sandbox is
 *     enforced independently of it. There is no prompt-free directory outside
 *     the container; `book/build/` is blocked just like /private/tmp.
 *
 *     Defence: stage both the input and the output INSIDE Word's container, and
 *     copy/move across the boundary with this (unsandboxed) Node process. The
 *     caller's input and output paths are therefore unrestricted -- including
 *     /private/tmp and the Desktop, both measured clean.
 *
 * A useful side effect of staging: no caller-controlled path is ever
 * interpolated into the AppleScript. Only our own generated tag name is.
 */

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

// Overridable so a non-standard install -- or a Linux CI box, where the same
// --headless --convert-to invocation works unchanged -- needs no code edit.
const SOFFICE =
  process.env.BOOK_BUILDER_SOFFICE || '/Applications/LibreOffice.app/Contents/MacOS/soffice';

const WORD_APP = '/Applications/Microsoft Word.app';
const WORD_CONTAINER = path.join(
  os.homedir(),
  'Library/Containers/com.microsoft.Word/Data/Documents'
);
const WORD_STAGE = path.join(WORD_CONTAINER, '.book-builder-stage');

// A dedicated LibreOffice profile. Without it, a conversion started while the
// user has LibreOffice open dies with "another instance is accessing the user
// profile" -- and soffice reports that on stderr while still exiting 0.
const LO_PROFILE = path.join(os.tmpdir(), 'book-builder-lo-profile');

// Journal for Word's "update links at open" preference. Written before the
// flip, removed after the restore; its presence on startup means a previous run
// died mid-flight.
const PREF_JOURNAL = path.join(
  os.homedir(),
  'Library/Application Support/book-builder/word-pref-journal.json'
);

const PREF_UI_PATH = "Word > Settings > General > 'Update automatic links at open'";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class RenderError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.hint = hint || null;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
    ...opts.spawn,
  });
  return {
    code: r.status,
    signal: r.signal,
    out: r.stdout || '',
    err: r.stderr || '',
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    error: r.error || null,
  };
}

function have(cmd) {
  return run('/usr/bin/which', [cmd]).code === 0;
}

function secs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function tag() {
  return `bb-${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function asQuote(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Input inspection
// ---------------------------------------------------------------------------

/**
 * Does word/document.xml carry a TOC/field instruction?
 *
 * Used for two things: warning that LibreOffice will render that TOC empty,
 * and deciding whether the Word preference actually matters for this document.
 */
function docxFieldInfo(docxPath) {
  const r = run('/usr/bin/unzip', ['-p', docxPath, 'word/document.xml']);
  if (r.code !== 0) return { readable: false, hasFields: false, hasToc: false };
  const xml = r.out;
  return {
    readable: true,
    hasFields: /<w:(fldChar|instrText|fldSimple)/.test(xml),
    hasToc: /TOC\s+\\/.test(xml) || /w:instrText[^>]*>\s*TOC/.test(xml),
  };
}

// ---------------------------------------------------------------------------
// Engine: LibreOffice
// ---------------------------------------------------------------------------

function checkLibreOffice() {
  if (!fs.existsSync(SOFFICE)) {
    throw new RenderError(
      'LO_MISSING',
      `LibreOffice not found at ${SOFFICE}`,
      'Install it (brew install --cask libreoffice) or render with --engine word.'
    );
  }
}

/**
 * Convert with `soffice --headless`. Unsandboxed, so input and output may live
 * anywhere; no prompt is possible.
 */
function renderLibreOffice(input, output, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000;
  checkLibreOffice();

  const started = Date.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-lo-'));
  try {
    const r = run(
      SOFFICE,
      [
        `-env:UserInstallation=file://${LO_PROFILE}`,
        '--headless',
        '--invisible',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        input,
      ],
      { timeoutMs }
    );

    if (r.timedOut) {
      throw new RenderError(
        'LO_TIMEOUT',
        `LibreOffice did not finish within ${secs(timeoutMs)}`,
        'Raise --timeout, or check for a stuck soffice process (pgrep -fl soffice).'
      );
    }

    // soffice exits 0 on several silent failures, so the artefact is the only
    // acceptable evidence of success.
    const produced = path.join(workDir, `${path.basename(input, path.extname(input))}.pdf`);
    if (!fs.existsSync(produced) || fs.statSync(produced).size === 0) {
      throw new RenderError(
        'LO_NO_OUTPUT',
        `LibreOffice exited ${r.code} but produced no PDF`,
        (r.err || r.out || '').trim().split('\n').slice(-3).join(' | ') || undefined
      );
    }

    fs.ensureDirSync(path.dirname(output));
    fs.moveSync(produced, output, { overwrite: true });
    return { engine: 'libreoffice', pdf: output, ms: Date.now() - started, stderr: r.err };
  } finally {
    fs.removeSync(workDir);
  }
}

// ---------------------------------------------------------------------------
// Engine: Word
// ---------------------------------------------------------------------------

function checkWordInstalled() {
  if (!fs.existsSync(WORD_APP)) {
    throw new RenderError(
      'WORD_MISSING',
      `Microsoft Word not found at ${WORD_APP}`,
      'Render with --engine libreoffice, which needs no Office install.'
    );
  }
}

/** Run an AppleScript, mapping timeout/failure onto RenderError. */
function osa(script, timeoutMs) {
  return run('/usr/bin/osascript', ['-e', script], { timeoutMs });
}

/**
 * Wake Word and confirm it answers AppleScript.
 *
 * A Word that is unlicensed, signed out, or showing a "new version available"
 * modal accepts the launch and then never answers -- so an unanswered probe is
 * the detector for all of those at once.
 */
function wakeWord(timeoutMs) {
  run('/usr/bin/open', ['-g', '-a', 'Microsoft Word'], { timeoutMs: 30000 });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = osa('tell application "Microsoft Word" to return (count of documents) as string', 15000);
    if (r.code === 0) return parseInt(r.out.trim(), 10);
    last = r;
    run('/bin/sleep', ['1']);
  }
  throw new RenderError(
    'WORD_UNRESPONSIVE',
    `Word did not answer AppleScript within ${secs(timeoutMs)}` +
      (last && last.err.trim() ? `: ${last.err.trim().split('\n')[0]}` : ''),
    'Word is probably showing a sign-in, activation or update dialog. Open Word ' +
      'by hand, clear it, then re-run. Or use --engine libreoffice.'
  );
}

function readUpdateLinksPref() {
  const r = osa(
    'tell application "Microsoft Word" to return (update links at open of settings) as string',
    20000
  );
  if (r.code !== 0) return null;
  return r.out.trim() === 'true';
}

function writeUpdateLinksPref(value) {
  const r = osa(
    `tell application "Microsoft Word" to set update links at open of settings to ${value ? 'true' : 'false'}`,
    20000
  );
  return r.code === 0;
}

/**
 * If a previous run was killed between the flip and the restore, the user's
 * preference is still off. Put it back before doing anything else.
 *
 * Returns a description of what happened, or null if there was nothing to do.
 */
function recoverPrefJournal() {
  if (!fs.existsSync(PREF_JOURNAL)) return null;
  let journal;
  try {
    journal = fs.readJsonSync(PREF_JOURNAL);
  } catch (e) {
    fs.removeSync(PREF_JOURNAL);
    return { recovered: false, reason: 'journal unreadable; discarded' };
  }
  const want = journal.originalValue !== false;
  if (writeUpdateLinksPref(want)) {
    fs.removeSync(PREF_JOURNAL);
    return {
      recovered: true,
      restoredTo: want,
      from: journal,
    };
  }
  return {
    recovered: false,
    restoredTo: want,
    from: journal,
    reason: `could not talk to Word; set ${PREF_UI_PATH} back to ${want ? 'ON' : 'OFF'} by hand`,
  };
}

function buildWordScript(stagedDocx, stagedPdf, docName) {
  // `open` is invoked as a statement, not as `set d to open ...`: Word's
  // implementation returns no Apple event result despite what its sdef claims,
  // so the assignment form leaves d undefined and the next line dies with -2753.
  // The document is picked up by name instead -- safe because the name is our
  // own unique tag, and because `save as ... format PDF` leaves the open
  // document still named <tag>.docx (verified).
  return `
tell application "Microsoft Word"
    open (POSIX file "${asQuote(stagedDocx)}") confirm conversions false add to recent files false
    set d to document "${asQuote(docName)}"
    try
        -- The preference is off, so Word will not update fields on its own.
        -- Do explicitly what the suppressed prompt was asking permission to do.
        repeat with i from 1 to (count of fields of d)
            update field (field i of d)
        end repeat
        repeat with i from 1 to (count of tables of contents of d)
            update (table of contents i of d)
        end repeat
        repeat with i from 1 to (count of tables of figures of d)
            update (table of figures i of d)
        end repeat
        repaginate d
        -- Second pass: inserting the TOC reflows the body, so the page numbers
        -- the first pass wrote can already be stale.
        repeat with i from 1 to (count of tables of contents of d)
            update page numbers (table of contents i of d)
        end repeat
        save as d file name "${asQuote(stagedPdf)}" file format format PDF
        close d saving no
    on error errMsg number errNum
        try
            close document "${asQuote(docName)}" saving no
        end try
        error errMsg number errNum
    end try
end tell
`.trim();
}

/**
 * Belt and braces: close any document left open under our tag.
 *
 * The staged .docx is deleted either way, but a document Word still holds open
 * would sit there as an untitled orphan after a timeout, and the next run would
 * inherit a confusing UI. `every document` does not answer `count`, hence the
 * reverse index loop.
 */
function closeStagedDocs(prefix) {
  osa(
    `
tell application "Microsoft Word"
    repeat with i from (count of documents) to 1 by -1
        try
            if (name of document i) starts with "${asQuote(prefix)}" then close document i saving no
        end try
    end repeat
end tell
`.trim(),
    20000
  );
}

/**
 * Convert with Microsoft Word. Prompt-free; see the file header for why each
 * step is here.
 *
 * opts.allowPrefToggle (default true) — set false to forbid touching the user's
 * "update links at open" preference. When it is off and the preference is in
 * the prompting state, this throws NEEDS_PREF with the exact instruction rather
 * than hanging on a modal.
 */
function renderWord(input, output, opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000;
  const allowPrefToggle = opts.allowPrefToggle !== false;
  const notes = [];

  checkWordInstalled();
  const started = Date.now();

  wakeWord(Math.min(timeoutMs, 90000));

  const recovery = recoverPrefJournal();
  if (recovery) notes.push({ kind: 'pref-recovery', ...recovery });

  const original = readUpdateLinksPref();
  if (original === null) {
    throw new RenderError(
      'WORD_UNRESPONSIVE',
      'Word answered the document count but not the settings query',
      'Quit and reopen Word, then re-run. Or use --engine libreoffice.'
    );
  }

  if (original === true && !allowPrefToggle) {
    const info = docxFieldInfo(input);
    if (info.hasFields) {
      throw new RenderError(
        'NEEDS_PREF',
        'Word will show the "fields that may refer to other files" prompt for this document',
        `Turn OFF ${PREF_UI_PATH} (or drop --no-word-pref-toggle to let this script ` +
          'flip it for the duration of the run and put it back).'
      );
    }
    notes.push({ kind: 'pref-untouched', reason: 'document carries no fields' });
  }

  const willToggle = original === true && allowPrefToggle;

  fs.ensureDirSync(WORD_STAGE);
  const t = tag();
  const stagedDocx = path.join(WORD_STAGE, `${t}.docx`);
  const stagedPdf = path.join(WORD_STAGE, `${t}.pdf`);
  fs.copySync(input, stagedDocx);

  const cleanup = () => {
    // Word's owner file is NOT "~$<name>": it is "~$" plus the name with its
    // first two characters dropped ("bb-123.docx" -> "~$-123.docx"). Matching on
    // the tag's tail catches both spellings and cannot touch a sibling run.
    const tail = t.slice(2);
    for (const name of fs.existsSync(WORD_STAGE) ? fs.readdirSync(WORD_STAGE) : []) {
      if (name.includes(tail)) fs.removeSync(path.join(WORD_STAGE, name));
    }
  };

  let result;
  try {
    if (willToggle) {
      // Journal FIRST. If we are killed before the restore, the next run undoes
      // this for the user.
      fs.ensureDirSync(path.dirname(PREF_JOURNAL));
      fs.writeJsonSync(PREF_JOURNAL, {
        originalValue: original,
        pid: process.pid,
        input,
        startedAt: new Date().toISOString(),
      });
      if (!writeUpdateLinksPref(false)) {
        fs.removeSync(PREF_JOURNAL);
        throw new RenderError(
          'WORD_UNRESPONSIVE',
          'Could not set Word\'s "update links at open" preference',
          `Turn OFF ${PREF_UI_PATH} by hand, then re-run.`
        );
      }
      notes.push({ kind: 'pref-toggled', from: original, to: false });
    }

    const script = buildWordScript(stagedDocx, stagedPdf, `${t}.docx`);
    result = osa(script, timeoutMs);
  } finally {
    if (willToggle) {
      const ok = writeUpdateLinksPref(original);
      if (ok) {
        fs.removeSync(PREF_JOURNAL);
        notes.push({ kind: 'pref-restored', to: original });
      } else {
        notes.push({
          kind: 'pref-restore-failed',
          to: original,
          hint: `Set ${PREF_UI_PATH} back to ${original ? 'ON' : 'OFF'} yourself, ` +
            'or re-run this script -- it restores the journalled value on start.',
        });
      }
    }
  }

  let closedCleanly = false;
  try {
    if (result.timedOut) {
      throw new RenderError(
        'WORD_TIMEOUT',
        `Word did not finish within ${secs(timeoutMs)}`,
        'Check Word for an unexpected modal dialog and clear it. The staged document ' +
          'was closed and the preference restored; if Word was wedged, the next run ' +
          'replays the preference journal.'
      );
    }
    if (result.code !== 0) {
      throw new RenderError(
        'WORD_SCRIPT_FAILED',
        `Word AppleScript failed (exit ${result.code})`,
        (result.err || '').trim().split('\n')[0] || undefined
      );
    }
    if (!fs.existsSync(stagedPdf) || fs.statSync(stagedPdf).size === 0) {
      throw new RenderError(
        'WORD_NO_OUTPUT',
        'Word reported success but produced no PDF',
        `Nothing at ${stagedPdf}. If this repeats, open the docx in Word by hand.`
      );
    }

    fs.ensureDirSync(path.dirname(output));
    // Across the sandbox boundary, by this unsandboxed process.
    fs.moveSync(stagedPdf, output, { overwrite: true });
    closedCleanly = true;
    return { engine: 'word', pdf: output, ms: Date.now() - started, notes };
  } finally {
    // On the happy path the script already closed the document; only pay for
    // the extra round-trip when something went wrong and it may still be open.
    if (!closedCleanly) closeStagedDocs(t);
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Rasterise + inspect (this is how every check in this project is actually made)
// ---------------------------------------------------------------------------

function rasterize(pdf, pngPath, opts = {}) {
  const page = opts.page || 1;
  const density = opts.density || 130;
  if (!have('magick')) {
    throw new RenderError(
      'MAGICK_MISSING',
      'ImageMagick `magick` not on PATH',
      'brew install imagemagick, or drop --png.'
    );
  }
  fs.ensureDirSync(path.dirname(pngPath));
  const r = run(
    'magick',
    ['-density', String(density), `${pdf}[${page - 1}]`, pngPath],
    { timeoutMs: opts.timeoutMs || 120000 }
  );
  if (r.code !== 0 || !fs.existsSync(pngPath)) {
    throw new RenderError(
      'RASTER_FAILED',
      `Could not rasterise page ${page} of ${path.basename(pdf)}`,
      (r.err || '').trim().split('\n')[0] || undefined
    );
  }
  return { png: pngPath, page, density };
}

/**
 * Cheap facts about a PDF, for the --engine both comparison. Every probe is
 * optional: a missing poppler tool degrades the row, it does not fail the run.
 */
function inspectPdf(pdf) {
  const info = { bytes: fs.statSync(pdf).size, pages: null, fonts: null, tocLines: null };

  if (have('pdfinfo')) {
    const r = run('pdfinfo', [pdf], { timeoutMs: 30000 });
    const m = r.out.match(/^Pages:\s+(\d+)/m);
    if (m) info.pages = parseInt(m[1], 10);
  }
  if (have('pdffonts')) {
    const r = run('pdffonts', [pdf], { timeoutMs: 30000 });
    const fams = new Set();
    for (const line of r.out.split('\n').slice(2)) {
      const name = line.trim().split(/\s+/)[0];
      if (name) fams.add(name.replace(/^[A-Z]{6}\+/, ''));
    }
    if (fams.size) info.fonts = [...fams].sort();
  }
  if (have('pdftotext')) {
    const r = run('pdftotext', [pdf, '-'], { timeoutMs: 60000 });
    // Dot-leader lines are the TOC signature, and the metric the Word-vs-LO
    // difference was originally measured with.
    info.tocLines = (r.out.match(/\.{4,}/g) || []).length;
  }
  return info;
}

module.exports = {
  RenderError,
  ENGINES: ['libreoffice', 'word', 'both'],
  SOFFICE,
  WORD_APP,
  WORD_STAGE,
  LO_PROFILE,
  PREF_JOURNAL,
  PREF_UI_PATH,
  docxFieldInfo,
  checkLibreOffice,
  checkWordInstalled,
  renderLibreOffice,
  renderWord,
  recoverPrefJournal,
  readUpdateLinksPref,
  rasterize,
  inspectPdf,
};
