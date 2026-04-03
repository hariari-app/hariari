import { EditorView } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { go } from '@codemirror/lang-go';
import type { Extension } from '@codemirror/state';

export function getLanguageExtension(filePath: string): Extension {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs': return javascript({ typescript: ext.startsWith('ts'), jsx: ext.endsWith('x') });
    case 'py': case 'pyw': return python();
    case 'html': case 'htm': case 'svelte': case 'vue': return html();
    case 'css': case 'scss': case 'less': return css();
    case 'json': case 'jsonc': return json();
    case 'md': case 'mdx': return markdown();
    case 'rs': return rust();
    case 'c': case 'h': case 'cpp': case 'hpp': case 'cc': case 'cxx': return cpp();
    case 'java': case 'kt': case 'kts': return java();
    case 'xml': case 'svg': case 'plist': return xml();
    case 'sql': return sql();
    case 'yaml': case 'yml': return yaml();
    case 'go': return go();
    default: return [];
  }
}

export const cmTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: "'JetBrains Mono', 'Fira Code', monospace" },
  '.cm-gutters': { minWidth: '48px' },
});
