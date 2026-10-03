#!/usr/bin/env node

/**
 * Remap every .excalidraw source to the light theme and emit a browser harness that
 * re-renders them with the real Excalidraw engine.
 *
 * WHY A BROWSER HARNESS
 * ---------------------
 * Excalidraw's exporter is a browser bundle: @excalidraw/utils needs a DOM, and the
 * node wrapper packages have rotted against the current layout. The options were a
 * headless-Chrome dependency in the build, or this -- a self-contained page you open
 * once. This keeps book-builder dependency-free and renders with the same engine the
 * app uses, so the output matches what the diagrams look like in Excalidraw rather
 * than approximating them with a third-party renderer.
 *
 * It writes the PNGs straight back into images/diagrams/ via the File System Access
 * API, so there is no 61-file download pile to sort out afterwards.
 *
 * Colour decisions live in lib/diagram-theme.js, with the contrast measurements that
 * justify them.
 */

const fs = require('fs');
const path = require('path');
const { toLightTheme } = require('./lib/diagram-theme.js');

const OUT = path.resolve(process.cwd(), 'build', 'diagram-harness');
const SRC = path.resolve(process.cwd(), 'images', 'diagrams');
// Long edge of the rendered PNG. The text block at 6x9 is 4.75in, so 300dpi needs
// 1425px; 2400 leaves room for the downstream pad/border and for a diagram to be
// placed larger than one column if the layout ever calls for it.
const TARGET_LONG_EDGE = 2400;

function main() {
  if (!fs.existsSync(SRC)) { console.error(`no ${SRC}`); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });

  const scenes = [];
  let remapped = 0;
  for (const chapter of fs.readdirSync(SRC)) {
    const dir = path.join(SRC, chapter);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.excalidraw')) continue;
      const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const n = toLightTheme(doc);
      remapped += n;
      scenes.push({
        chapter,
        // The PNGs the manuscript references are "<name>.excalidraw.png".
        out: `${name}.png`,
        elements: doc.elements || [],
        appState: {
          viewBackgroundColor: doc.appState?.viewBackgroundColor || '#FFFFFF',
          exportBackground: true,
          exportWithDarkMode: false,
          theme: 'light',
        },
        files: doc.files || {},
        count: (doc.elements || []).length,
      });
    }
  }

  fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes));
  fs.writeFileSync(path.join(OUT, 'index.html'), html(scenes.length, TARGET_LONG_EDGE));
  console.log(`  ${scenes.length} scenes remapped (${remapped} colour values changed)`);
  console.log(`  harness: ${path.join(OUT, 'index.html')}`);
  const thin = scenes.filter((s) => s.count <= 2);
  if (thin.length) console.log(`  note: ${thin.length} scene(s) have <=2 elements and may be genuinely empty`);
}

function html(count, longEdge) {
  return `<!doctype html>
<meta charset="utf-8">
<title>Constellize diagram re-render</title>
<style>
  body{font:14px system-ui;margin:2rem;max-width:52rem}
  button{font:inherit;padding:.6rem 1rem;cursor:pointer}
  #log{margin-top:1rem;font-family:ui-monospace,monospace;font-size:12px;
       white-space:pre-wrap;max-height:60vh;overflow:auto;border:1px solid #ddd;padding:.75rem}
  .ok{color:#137333}.bad{color:#c5221f}
</style>
<h1>Re-render ${count} diagrams in light theme</h1>
<p>Renders every diagram with the real Excalidraw engine and writes the PNGs straight back
into <code>images/diagrams/</code>.</p>
<ol>
  <li>Click the button.</li>
  <li>When Chrome asks, pick the <code>images/diagrams</code> folder and allow editing.</li>
</ol>
<p><button id="go">Choose images/diagrams and render</button></p>
<div id="log">ready.</div>
<script type="module">
import * as Ex from 'https://esm.sh/@excalidraw/excalidraw@0.18.0';
const log = (m, cls='') => {
  const d = document.createElement('div'); if (cls) d.className = cls;
  d.textContent = m; document.getElementById('log').appendChild(d);
  d.scrollIntoView({block:'nearest'});
};
document.getElementById('go').onclick = async () => {
  let root;
  try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); }
  catch { return log('cancelled', 'bad'); }
  const scenes = await (await fetch('scenes.json')).json();
  let ok = 0, bad = 0;
  for (const s of scenes) {
    try {
      const blob = await Ex.exportToBlob({
        elements: s.elements, appState: s.appState, files: s.files,
        mimeType: 'image/png', exportPadding: 16,
        getDimensions: (w, h) => {
          const scale = ${longEdge} / Math.max(w, h);
          return { width: Math.round(w*scale), height: Math.round(h*scale), scale };
        },
      });
      const dir = await root.getDirectoryHandle(s.chapter, { create: true });
      const fh = await dir.getFileHandle(s.out, { create: true });
      const w = await fh.createWritable();
      await w.write(blob); await w.close();
      ok++; log(\`ok   \${s.chapter}/\${s.out}  (\${s.count} elements, \${(blob.size/1024)|0} KB)\`, 'ok');
    } catch (e) {
      bad++; log(\`FAIL \${s.chapter}/\${s.out}: \${e.message}\`, 'bad');
    }
  }
  log(\`\\ndone: \${ok} written, \${bad} failed\`, bad ? 'bad' : 'ok');
};
</script>`;
}

main();
