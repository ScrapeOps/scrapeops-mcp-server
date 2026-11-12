declare module 'firecrawl-fastmcp' {
  import type { IncomingHttpHeaders } from 'http';

  export interface Logger {
    debug(...args: unknown[]): void;
    error(...args: unknown[]): void;
    info(...args: unknown[]): void;
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  }

  export type TransportArgs =
    | { transportType: 'stdio' }
    | {
        transportType: 'httpStream';
        httpStream: {
          port: number;
          host?: string;
          stateless?: boolean;
          endpoint?: `/${string}`;
          enableJsonResponse?: boolean;
        };
      };

  export interface ToolContext<Session = unknown> {
    session?: Session;
    log: Logger;
  }

  export type ToolExecute<Session = unknown> = (
    args: unknown,
    context: ToolContext<Session>
  ) => unknown | Promise<unknown>;

  export class FastMCP<Session = unknown> {
    constructor(options: {
      name: string;
      version?: string;
      logger?: Logger;
      roots?: { enabled?: boolean };
      authenticate?: (
        request: { headers: IncomingHttpHeaders }
      ) => Promise<Session> | Session;
      health?: {
        enabled?: boolean;
        message?: string;
        path?: string;
        status?: number;
      };
    });

    addTool(tool: {
      name: string;
      description?: string;
      annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
      parameters?: unknown;
      execute: ToolExecute<Session>;
    }): void;

    start(args?: TransportArgs): Promise<void>;
    stop(): Promise<void>;
  }
}


