// main.ts — mend, candidate 1 ("Literal").
// A command-line tool that applies AI-written edits (unified diff, SEARCH/REPLACE,
// V4A patch, JSON tool calls) to a tree of text files, per SPEC.md v1.
// Node 22, standard library alone. Run as: node main.ts [options] [PATCH].

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's line break: CRLF when its first line feed follows a carriage return, else LF. */
function fileBreak(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

interface SplitFile {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): SplitFile {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = fileBreak(text);
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

/* ---------- section 5: matching lines ---------- */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based positions where O occurs in `lines` at `tier` (occurrences may overlap). */
function occurrencesAt(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0..maxTier) at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], O: string[], maxTier: number, from = 0): { tier: number; pos: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const pos = occurrencesAt(lines, O, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line; a new line as the patch's. */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Split a hunk/chunk body into O (context + old lines) and N (context + new lines). */
function hunkON(body: { kind: 'ctx' | 'old' | 'new'; text: string }[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    if (l.kind === 'ctx') {
      const oIdx = O.length;
      O.push(l.text);
      N.push({ text: l.text, ctx: true, oIdx });
    } else if (l.kind === 'old') {
      O.push(l.text);
    } else {
      N.push({ text: l.text, ctx: false, oIdx: -1 });
    }
  }
  return { O, N };
}

/** Replace O (matched at `at`) by N in `lines`, honouring section 5's context and tier-2 re-indent. */
function applyON(lines: string[], O: string[], N: NLine[], tier: number, at: number): string[] {
  const out = lines.slice(0, at);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(lines[at]!);
    P = leadingWs(O[0]!);
  }
  for (const nl of N) {
    if (nl.ctx) {
      out.push(lines[at + nl.oIdx]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(at + O.length));
  return out;
}

/** The N lines as plain text (for insertions and creations). */
function nTexts(N: NLine[]): string[] {
  return N.map((l) => l.text);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}


/* ---------- section 6: unified diffs ---------- */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  A: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffGit: [string, string] | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const t = line.slice(4).split('\t')[0]!;
  return t.trim();
}

function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  const parts = rest.split(' ');
  if (parts.length !== 2) return null;
  const a = parts[0]!;
  const b = parts[1]!;
  if (!a.startsWith('a/') || !b.startsWith('b/')) return null;
  if (a.length <= 2 || b.length <= 2) return null;
  return [a.slice(2), b.slice(2)];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return parseInt(m[1]!, 10);
}

/** Does a `\` line follow the hunk's last context or `+` body line? */
function hunkNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
  }
  return last >= 0 && body[last + 1]?.kind === 'bs';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inBody = false;
  let curHunk: Hunk | null = null;

  const trimBody = (h: Hunk): void => {
    // empty lines at the end of a body are not part of it
    while (h.body.length > 0) {
      const last = h.body[h.body.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') h.body.pop();
      else break;
    }
  };
  const endBody = (): void => {
    if (curHunk !== null) trimBody(curHunk);
    inBody = false;
    curHunk = null;
  };
  const startSection = (): Section => {
    endBody();
    const s: Section = { oldPath: null, newPath: null, hasPair: false, renameFrom: null, renameTo: null, diffGit: null, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    // A section or hunk boundary ends a body, even though `--- ` starts with `-`.
    if (line.startsWith('diff --git ')) {
      endBody();
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffGit = dg;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      endBody();
      if (cur !== null && !cur.hasPair && cur.hunks.length === 0) {
        const oldP = headerPath(line);
        const newP = headerPath(next);
        cur.oldPath = oldP === '/dev/null' ? null : stripAB(oldP);
        cur.newPath = newP === '/dev/null' ? null : stripAB(newP);
        if (oldP === '/dev/null') cur.create = true;
        if (newP === '/dev/null') cur.del = true;
        cur.hasPair = true;
        i += 2;
        continue;
      }
      const oldP = headerPath(line);
      const newP = headerPath(next);
      const s = startSection();
      s.oldPath = oldP === '/dev/null' ? null : stripAB(oldP);
      s.newPath = newP === '/dev/null' ? null : stripAB(newP);
      if (oldP === '/dev/null') s.create = true;
      if (newP === '/dev/null') s.del = true;
      s.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      endBody();
      const A = parseHunkHeader(line);
      if (A === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { A, body: [] };
      cur.hunks.push(curHunk);
      inBody = true;
      i++;
      continue;
    }
    if (inBody) {
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind: BodyLine['kind'] = line === '' ? 'ctx' : line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : line.startsWith('+') ? 'new' : 'bs';
        const text = line === '' ? '' : kind === 'bs' ? line : line.slice(1);
        curHunk!.body.push({ kind, text });
        i++;
        continue;
      }
      endBody();
    }
    if (line.startsWith('--- ')) {
      if (cur !== null) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && !inBody) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i++;
      continue;
    }
    i++;
  }
  endBody();

  // Resolve each section's paths: ---/+++ pair > rename from/to > diff --git.
  for (const s of sections) {
    if (s.oldPath === null && s.newPath === null) {
      if (s.renameFrom !== null || s.renameTo !== null) {
        s.oldPath = s.renameFrom;
        s.newPath = s.renameTo;
      } else if (s.diffGit !== null) {
        s.oldPath = s.diffGit[0];
        s.newPath = s.diffGit[1];
      }
    } else if (s.oldPath === null && s.renameFrom !== null) {
      s.oldPath = s.renameFrom;
    } else if (s.newPath === null && s.renameTo !== null) {
      s.newPath = s.renameTo;
    }
  }
  return sections.filter((s) => s.oldPath !== null || s.newPath !== null).map((s) => sectionEdit(s, strict));
}
function sectionEdit(s: Section, strict: boolean): Edit {
  return (tree: Tree): void => {
    const maxTier = strict ? 0 : 2;
    if (s.create) {
      const p = s.newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let final = true;
      for (const h of s.hunks) {
        for (const bl of h.body) if (bl.kind === 'new') out.push(bl.text);
        if (hunkNoEol(h.body)) final = false;
      }
      tree.set(p, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (s.del) {
      const p = s.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const source = oldP ?? newP!;
    if (!safe(source)) throw new Fail('unsafe', source);
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(source);
    if (before === null) throw new Fail('missing', source);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const sf = splitFile(before);
    let fileLines = sf.lines;
    let final = sf.final;
    const br = sf.br;
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = hunkON(h.body.filter((b) => b.kind !== 'bs'));
      if (O.length === 0) {
        const oldLen = fileLines.length;
        const pos = Math.min(h.A + d, oldLen);
        const texts = nTexts(N);
        fileLines = [...fileLines.slice(0, pos), ...texts, ...fileLines.slice(pos)];
        if (pos === oldLen) final = !hunkNoEol(h.body);
        d += N.length;
        continue;
      }
      const oldLen = fileLines.length;
      const found = findTier(fileLines, O, maxTier);
      if (found === null) throw new Fail('no-match', source);
      const want = h.A - 1 + d;
      let at = found.pos[0]!;
      let best = Math.abs(at - want);
      for (const p of found.pos) {
        const dist = Math.abs(p - want);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const ranToEnd = at + O.length === oldLen;
      fileLines = applyON(fileLines, O, N, found.tier, at);
      if (ranToEnd) final = !hunkNoEol(h.body);
      d += N.length - O.length;
    }
    const out = joinFile(fileLines, br, final);
    if (isMove) {
      tree.set(source, null);
      tree.set(newP!, out);
      tree.moves.push({ old: source, nw: newP! });
    } else {
      tree.set(source, out);
    }
  };
}

/* ---------- section 7: SEARCH/REPLACE blocks ---------- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const sf = splitFile(before);
    const found = findTier(sf.lines, oldLines, strict ? 0 : 2);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const out = applyON(sf.lines, oldLines, N, found.tier, found.pos[0]!);
    tree.set(path, joinFile(out, sf.br, sf.final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let path: string | null = null;
    for (let k = sIdx - 1; k > prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = sIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    edits.push(srEdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ---------- section 8: V4A patches ---------- */

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      i++;
      const flines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        const l = lines[i]!;
        if (l.startsWith('+')) flines.push(l.slice(1));
        else if (l === '') flines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.set(p, flines.length === 0 ? '' : flines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push((tree: Tree): void => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.set(p, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      const pushChunk = (): void => {
        if (curChunk !== null && curChunk.body.length > 0) chunks.push(curChunk);
        curChunk = null;
      };
      while (i < last && !isSectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          pushChunk();
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          i++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          curChunk.eof = true;
          pushChunk();
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          const kind: BodyLine['kind'] = l === '' ? 'ctx' : l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
          curChunk.body.push({ kind, text: l === '' ? '' : l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushChunk();
      // blank lines at the end of the section are not part of it
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.kind === 'ctx' && lastChunk.body[lastChunk.body.length - 1]!.text === '') {
          lastChunk.body.pop();
        }
        if (lastChunk.body.length === 0) chunks.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const maxTier = strict ? 0 : 2;
    const sf = splitFile(before);
    let fileLines = sf.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      let cur = cursor;
      if (chunk.anchor !== null) {
        let anchorPos: number | null = null;
        for (let t = 0; t <= maxTier && anchorPos === null; t++) {
          for (let k = cur; k < fileLines.length; k++) {
            if (normLine(fileLines[k]!, t) === normLine(chunk.anchor, t)) {
              anchorPos = k;
              break;
            }
          }
        }
        if (anchorPos === null) throw new Fail('no-match', path);
        cur = anchorPos + 1;
      }
      const { O, N } = hunkON(chunk.body.filter((b) => b.kind !== 'bs'));
      if (O.length === 0) {
        const pos = chunk.eof ? fileLines.length : cur;
        const texts = nTexts(N);
        fileLines = [...fileLines.slice(0, pos), ...texts, ...fileLines.slice(pos)];
        cursor = pos + texts.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= maxTier && found === null; t++) {
        const pos = occurrencesAt(fileLines, O, t, cur);
        const ok = chunk.eof ? pos.filter((p) => p + O.length === fileLines.length) : pos;
        if (ok.length > 0) found = { tier: t, pos: ok[0]! };
      }
      if (found === null) throw new Fail('no-match', path);
      fileLines = applyON(fileLines, O, N, found.tier, found.pos);
      cursor = found.pos + N.length;
    }
    const out = joinFile(fileLines, sf.br, sf.final);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

/* ---------- section 9: JSON edits ---------- */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const sf = splitFile(before);
      if (line < 0 || line > sf.lines.length) throw new Fail('no-match', p);
      const lines = [...sf.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, joinFile(lines, sf.br, sf.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- run ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output lines, sorted by byte order of the path (a move sorts by its new path).
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old)! : wasOld;
    const nowNew = tree.now.has(mv.nw) ? tree.now.get(mv.nw)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      covered.add(mv.old);
      covered.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
