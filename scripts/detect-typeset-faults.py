#!/usr/bin/env python3
"""
Detect the typesetting fault classes the publisher reports, so before/after is measured
not eyeballed.

Each detector looks for the VISIBLE SYMPTOM in the finished PDF, because that is what a
reader sees and what the publisher reviewed. None of them read the LaTeX source.

Run:  python3 detect-typeset-faults.py build/print/constellize-book.pdf [--json out.json]
Test: cd book-builder && uv run pytest scripts/__tests__/detect_typeset_faults_test.py -v
"""
import subprocess, sys, re, json, datetime

# A running head carries the folio on the SAME line under -layout: the folio leads on a
# verso ("106     Chapter 4. ...") and trails on a recto ("4.1. ...        107"). Strip it
# explicitly or the first line of every headed page reads as content.
RUNNING_HEAD = re.compile(r'^\s*\d+\s{2,}\S|\S\s{2,}\d+\s*$')
BARE_FOLIO = re.compile(r'\s*\d+\s*')
# A line made only of closing delimiters: "}", "]", ");", "})" ... (p80's tail is "]").
CLOSERS_ONLY = re.compile(r'[\s\)\]\}>;,]+')
CAPTION = re.compile(r'^\s*Figure\s')
# A footnote body under -layout: a bare mark line ("a") then a URL line ("https : / / ...").
FOOTNOTE_MARK = re.compile(r'^\s*[a-z]\s*$')
URL_LINE = re.compile(r'^\s*https?\s*:')

KEYS = ('1_figure_in_callout', '2_orphan_tail', '3_word_across_figure',
        '4_widow_orphan', '5_missing_glyph')


def extract_pages(pdf):
    r = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True)
    # An unreadable PDF must fail loudly: empty output would otherwise score as "0 faults".
    if r.returncode != 0:
        raise RuntimeError(f'pdftotext failed on {pdf!r} (exit {r.returncode}): {r.stderr.strip()}')
    raw = r.stdout
    pages = raw.split('\f')
    # pdftotext ends every page, including the last, with a form feed, so the split leaves a
    # trailing empty segment that is not a page.
    if pages and not pages[-1].strip():
        pages.pop()
    if not pages:
        raise RuntimeError(f'no pages extracted from {pdf!r}; refusing to report zero faults')
    return pages


def find_faults(pdf_path):
    """Scan a PDF; return {'page_count': int, '<class key>': [findings...]}."""
    pages = extract_pages(pdf_path)
    N = len(pages)

    def lines(p, drop_head=True):
        ls = [l.rstrip() for l in pages[p-1].split('\n') if l.strip()]
        if drop_head and ls and RUNNING_HEAD.search(ls[0]):
            ls = ls[1:]
        return ls

    def bodylines(p):
        return [l for l in lines(p) if not BARE_FOLIO.fullmatch(l)]

    def has_caption(p):
        return any(CAPTION.match(l) for l in lines(p))

    def footnote_fragment(p):
        """Index (in the page's body lines) of a footnote body in the first few lines, else
        None. Such a footnote belongs to a callout reference on an earlier page. A page's
        own footnotes sit at the foot, so only the opening lines are examined."""
        ls = bodylines(p)
        for i, l in enumerate(ls[:5]):
            if FOOTNOTE_MARK.match(l) and i + 1 < len(ls) and URL_LINE.match(ls[i+1]):
                return i
        return None

    def caption_index(p):
        for i, l in enumerate(bodylines(p)):
            if CAPTION.match(l):
                return i
        return None

    findings = {k: [] for k in KEYS}

    for p in range(2, N + 1):
        ls = lines(p)
        if not ls:
            continue
        prevb = bodylines(p-1)
        firstb = (bodylines(p) or [''])[0]

        # 5. missing glyph
        for l in ls:
            if '\ufffd' in l:
                findings['5_missing_glyph'].append({'page': p, 'text': l.strip()[:70]})

        # 2. orphaned tail: page opens with nothing but closing delimiters, or a word
        #    hyphenated across the page break
        if firstb and CLOSERS_ONLY.fullmatch(firstb):
            findings['2_orphan_tail'].append({'page': p, 'text': firstb.strip(), 'kind': 'lone closer'})
        elif prevb and firstb:
            if prevb[-1].rstrip().endswith('-') and re.match(r'^[a-z]', firstb.strip()):
                kind = ('word split across a FIGURE page'
                        if has_caption(p-1) or has_caption(p) else 'word split across break')
                key = '3_word_across_figure' if 'FIGURE' in kind else '2_orphan_tail'
                findings[key].append({'page': p, 'text': f'{prevb[-1].strip()[-28:]} | {firstb.strip()[:28]}', 'kind': kind})

        # Orphaned callout footnote (class 1 or 2, decided by the figure caption's position):
        #  - caption BEFORE the fragment on the page: the figure sits between the callout and
        #    its footnote (p215)                                      -> class 1
        #  - fragment opens the page with no caption above it: the callout merely shed its
        #    tail across the break (p105; the figure is below)          -> class 2
        frag = footnote_fragment(p)
        cap = caption_index(p)
        if frag is not None:
            tail = prevb[-1].strip()[-34:] if prevb else ''
            if cap is not None and cap < frag:
                findings['1_figure_in_callout'].append(
                    {'page': p, 'text': tail, 'kind': 'callout footnote displaced past figure'})
            elif frag == 0:
                findings['2_orphan_tail'].append(
                    {'page': p, 'text': tail, 'kind': 'callout footnote orphaned at page head'})

        # 1 (secondary). A word hyphenated across a page that carries a figure caption.
        if cap is not None and frag is None:
            nxtb = bodylines(p+1) if p < N else []
            if prevb and nxtb and prevb[-1].strip().endswith('-'):
                tail, head = prevb[-1].strip(), nxtb[0].strip()
                findings['1_figure_in_callout'].append(
                    {'page': p, 'text': f'{tail[-34:]} | {head[:34]}', 'kind': 'word split across figure page'})

        # 4. widow/orphan: previous page ends on a lead-in line
        if prevb and prevb[-1].rstrip().endswith(':') and len(prevb[-1].strip()) > 12:
            findings['4_widow_orphan'].append({'page': p-1, 'text': prevb[-1].strip()[:64], 'kind': 'lead-in stranded at page foot'})

    for k in findings:
        seen = set(); uniq = []
        for f in findings[k]:
            sig = (f['page'], f.get('text'))
            if sig in seen:
                continue
            seen.add(sig); uniq.append(f)
        findings[k] = uniq

    assert N > 0
    findings['page_count'] = N
    return findings


VERSION_STAMP = re.compile(r'Author Preview\s+v(\d+\.\d+\.\d+)')


def pdf_version(pdf):
    """The book version stamped in the PDF's own front matter, else None. Read from the
    document measured, never from metadata.yaml: the build uses book-builder's template copy,
    and the two can disagree. Failure to read yields None; the faults scan has its own
    loud failure."""
    r = subprocess.run(['pdftotext', '-layout', '-f', '1', '-l', '6', pdf, '-'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    m = VERSION_STAMP.search(r.stdout)
    return m.group(1) if m else None


def provenance(pdf):
    """What produced a baseline, so a stale one can be recognised as stale. The filename
    carries none of this: baselines live at a stable, version-less path."""
    return {
        'source_pdf': pdf,
        'book_version': pdf_version(pdf),
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
    }


def main(argv):
    args = argv[1:]
    out = None
    if '--json' in args:
        i = args.index('--json')
        out = args[i+1]
        del args[i:i+2]
    pdf = args[0] if args else 'build/print/constellize-book.pdf'
    findings = find_faults(pdf)
    print(f"  {pdf}  --  {findings['page_count']} pages\n")
    for k in KEYS:
        label = k.split('_', 1)[1].replace('_', ' ')
        print(f"  S{k[0]}  {label:<26} {len(findings[k])}")
    print()
    findings['provenance'] = provenance(pdf)
    text = json.dumps(findings, indent=1)
    if out:
        with open(out, 'w') as fh:
            fh.write(text + '\n')
    else:
        print(text)


if __name__ == '__main__':
    main(sys.argv)
