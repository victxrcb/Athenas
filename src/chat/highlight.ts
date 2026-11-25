/** Syntax highlighting with only the languages that show up in coding conversations. */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, language] of Object.entries({ bash, c, cpp, csharp, css, dart, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, powershell, python, ruby, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}

const NAMES: Record<string, string> = {
  bash: 'Bash', c: 'C', cpp: 'C++', csharp: 'C#', css: 'CSS', dart: 'Dart', diff: 'Diff', dockerfile: 'Dockerfile', go: 'Go', ini: 'TOML / INI',
  java: 'Java', javascript: 'JavaScript', json: 'JSON', kotlin: 'Kotlin', markdown: 'Markdown', php: 'PHP', powershell: 'PowerShell', python: 'Python',
  ruby: 'Ruby', rust: 'Rust', sql: 'SQL', typescript: 'TypeScript', xml: 'HTML / XML', yaml: 'YAML',
};
const MAX_HIGHLIGHT = 60_000;

export function languageName(language: string): string {
  const known = hljs.getLanguage(language);
  if (!known) return language || 'Texto';
  const key = Object.keys(NAMES).find((name) => hljs.getLanguage(name) === known);
  return key ? NAMES[key] : language;
}

export function languageForPath(path: string): string {
  const extension = path.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
  const aliases: Record<string, string> = { tsx: 'typescript', ts: 'typescript', jsx: 'javascript', js: 'javascript', mjs: 'javascript', rs: 'rust', py: 'python', md: 'markdown', ps1: 'powershell', sh: 'bash', yml: 'yaml', toml: 'ini', html: 'xml', svg: 'xml', cs: 'csharp', kt: 'kotlin', rb: 'ruby', h: 'c', hpp: 'cpp' };
  const language = aliases[extension] ?? extension;
  return hljs.getLanguage(language) ? language : '';
}

/** Escaped HTML with highlight spans, or `null` when the code should be shown as plain text. */
export function highlight(code: string, language: string): string | null {
  if (!language || code.length > MAX_HIGHLIGHT || !hljs.getLanguage(language)) return null;
  // highlight.js escapes the source; only its own span markup is added.
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

/** Splits highlighted markup into lines, closing and reopening spans that cross a line break. */
export function htmlLines(html: string): string[] {
  const open: string[] = [];
  return html.split('\n').map((line) => {
    const prefix = open.join('');
    for (const tag of line.match(/<span[^>]*>|<\/span>/g) ?? []) {
      if (tag === '</span>') open.pop();
      else open.push(tag);
    }
    return prefix + line + '</span>'.repeat(open.length);
  });
}
