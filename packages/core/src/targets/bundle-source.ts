import * as fs from 'node:fs';
import * as path from 'node:path';

interface StagedFile {
  content: string;
  mode: number | undefined;
}

/** Read bundle inputs, allowing preflight to record paths and supply planned hook bytes. */
export class BundleSource {
  constructor(
    private readonly resolve: (src: string) => StagedFile | undefined = () => undefined,
  ) {}

  exists(src: string): boolean {
    return this.resolve(src) !== undefined || fs.existsSync(src);
  }

  readText(src: string): string {
    return this.resolve(src)?.content ?? fs.readFileSync(src, 'utf-8');
  }

  copyFile(src: string, dest: string): void {
    const staged = this.resolve(src);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (staged === undefined) {
      fs.copyFileSync(src, dest);
    } else {
      fs.writeFileSync(dest, staged.content);
      if (staged.mode !== undefined) fs.chmodSync(dest, staged.mode & 0o7777);
    }
  }

  private copyDir(src: string, dest: string): void {
    this.resolve(src);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        this.copyFile(srcPath, destPath);
      }
    }
  }

  copyIfExists(src: string, dest: string): boolean {
    const staged = this.resolve(src);
    if (staged === undefined && !fs.existsSync(src)) return false;
    if (staged === undefined && fs.statSync(src).isDirectory()) {
      this.copyDir(src, dest);
    } else {
      this.copyFile(src, dest);
    }
    return true;
  }
}
