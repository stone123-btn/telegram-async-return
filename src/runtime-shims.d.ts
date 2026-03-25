declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
}

declare const process: {
  argv: string[];
  cwd(): string;
  exitCode?: number;
  stdout: {
    write(chunk: string): boolean;
  };
  stderr: {
    write(chunk: string): boolean;
  };
};
