#!/bin/bash
# Which diagram to edit next, and exactly what it needs.
#
#   ./next-diagram.sh ch1        the chapter's remaining work, next one first
#   ./next-diagram.sh ch1 --open opens the next one in Excalidraw
#
# "Done" means every text size is on the ladder (16/20/28/36). Emoji are ignored.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$DIR/../../images/diagrams"
CH="${1:-}"
[ -z "$CH" ] && { echo "usage: next-diagram.sh <chapter> [--open]"; exit 1; }

python3 - "$ROOT" "$CH" "${2:-}" <<'PY'
import json, io, glob, sys, os, re, collections, subprocess
root, ch, flag = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv)>3 else ''
LADDER={16:'S',20:'M',28:'L',36:'XL'}
SH={'rectangle','ellipse','diamond'}
def box(e): return (e['x'],e['y'],e['x']+e.get('width',0),e['y']+e.get('height',0))
def ar(b): return max(0,b[2]-b[0])*max(0,b[3]-b[1])
def inter(a,b): return ar((max(a[0],b[0]),max(a[1],b[1]),min(a[2],b[2]),min(a[3],b[3])))

todo=[]
for f in sorted(glob.glob(os.path.join(root,ch,'*.excalidraw'))):
    d=json.load(io.open(f,encoding='utf-8'))
    els=[e for e in d['elements'] if not e.get('isDeleted')]
    ts=[e for e in els if e.get('type')=='text' and re.search(r'[A-Za-z0-9]', e.get('text','') or '')]
    if not ts: continue
    sizes=sorted({round(e['fontSize'],1) for e in ts})
    if all(s in LADDER for s in sizes): continue
    fonts=collections.Counter(e.get('fontFamily') for e in ts)
    sh=[e for e in els if e.get('type') in SH and e.get('width',0)>0]
    strad=sum(1 for A in sh for B in sh if A is not B and ar(box(A))>=4*ar(box(B))
              and 0.10 < inter(box(A),box(B))/ar(box(B)) < 0.92)
    # suggest a mapping: smallest distinct size -> S, then M, L, XL
    ladder=[16,20,28,36]
    plan=[(s, ladder[min(i,3)]) for i,s in enumerate(sizes)]
    todo.append((f,sizes,plan,strad,fonts,len(ts)))

if not todo:
    print(f"  {ch}: all done"); raise SystemExit
f,sizes,plan,strad,fonts,n = todo[0]
name=os.path.relpath(f,root)
print(f"  NEXT  {name}        ({len(todo)} left in {ch})")
print()
print(f"  {n} labels, {len(sizes)} distinct sizes. Suggested mapping:")
for old,new in plan:
    print(f"      {old:>6} ({old/2:>4.1f}pt)  ->  {new:>2} = {LADDER[new]}  ({new/2:.0f}pt)")
if 3 in fonts:
    print(f"\n  ** {fonts[3]} label(s) in monospace -- switch to Excalifont to match the book **")
if strad:
    print(f"\n  ** {strad} shape(s) straddling a container edge -- may be a layout bug, may be icon art **")
print()
print( "  1. Reload the file in Excalidraw (a stale tab will clobber the canvas guide)")
print(f"  2. Edit, set type with the S/M/L/XL buttons")
print( "  3. Cmd+A then Alt+/  -- width must read 684")
print(f"  4. node book-builder/scripts/finish-diagram.js {name.replace('.excalidraw','')}")
print()
print( "  remaining after this one:")
for g,_,_,_,_,_ in todo[1:]:
    print(f"      {os.path.relpath(g,root)}")

if flag=='--open':
    subprocess.run([os.path.join(root,'excalidraw-open'), f], check=False)
PY
