/** File extensions treated as plain text (synced as UTF-8 strings) */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.html', '.htm',
  '.xml', '.js', '.ts', '.jsx', '.tsx', '.css', '.scss', '.less',
  '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.cpp', '.h', '.toml', '.ini', '.env', '.log', '.svg', '.mjs', '.cjs',
]);

export class FileEncoder {
  static isText(path: string): boolean {
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
  }

  /**
   * Encode ArrayBuffer to a string for JSON transport.
   * Text files → UTF-8 string. Binary files → base64 string.
   */
  static encode(
    content: ArrayBuffer,
    path: string
  ): { encoded: string; encoding: 'utf8' | 'base64' } {
    if (FileEncoder.isText(path)) {
      return {
        encoded: new TextDecoder('utf-8').decode(content),
        encoding: 'utf8',
      };
    }
    // Binary → base64
    const bytes = new Uint8Array(content);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { encoded: btoa(binary), encoding: 'base64' };
  }

  /**
   * Decode a transport string back to ArrayBuffer.
   */
  static decode(encoded: string, encoding: 'utf8' | 'base64'): ArrayBuffer {
    if (encoding === 'utf8') {
      return new TextEncoder().encode(encoded).buffer;
    }
    // base64 → binary
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
