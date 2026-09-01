// Reading dropped/chosen transcript files into { name, text } records.
// Uses File.text() for smaller files; streams large ones line-by-line with
// awaited yields so the UI thread keeps breathing.

export interface LoadedFile {
  name: string;
  text: string;
}

/** Read every chosen/dropped file sequentially (keeps the UI responsive). */
export async function readFiles(files: FileList | File[]): Promise<LoadedFile[]> {
  const out: LoadedFile[] = [];
  for (const file of Array.from(files)) {
    out.push(await readTextFile(file));
  }
  return out;
}

export async function readTextFile(file: File, onStatus?: (s: string) => void): Promise<LoadedFile> {
  if (file.size <= 50 * 1024 * 1024) {
    return { name: file.name, text: await file.text() };
  }
  const chunks: string[] = [];
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let index = 0;
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = carry.indexOf('\n')) !== -1) {
      chunks.push(carry.slice(0, nl + 1));
      carry = carry.slice(nl + 1);
    }
    index += 1;
    if (index % 64 === 0) {
      onStatus?.(`streaming ${file.name}: ${(chunks.length / 1000).toFixed(0)}k lines…`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  carry += decoder.decode();
  if (carry.length > 0) chunks.push(carry.includes('\n') ? carry : `${carry}\n`);
  return { name: file.name, text: chunks.join('') };
}
