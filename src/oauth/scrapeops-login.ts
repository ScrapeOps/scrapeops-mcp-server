export class LoginError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface ScrapeOpsAccount {
  id: string;
  name: string;
  apiKey: string;
}

export type ScrapeOpsLogin = (email: string, password: string) => Promise<ScrapeOpsAccount[]>;

interface RawAccount {
  id?: number | string;
  name?: string;
  api_key?: string;
  banned?: boolean | null;
}

export function createScrapeOpsLogin(backendUrl: string): ScrapeOpsLogin {
  return async (email: string, password: string) => {
    let response: Response;
    try {
      response = await fetch(`${backendUrl}/auth/login`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new LoginError('ScrapeOps login is unavailable. Try again in a moment.');
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new LoginError('Incorrect email or password.');
    }
    if (!response.ok) {
      throw new LoginError('ScrapeOps login is unavailable. Try again in a moment.');
    }

    const body = (await response.json()) as { accounts?: RawAccount[] };
    const accounts = (body.accounts ?? [])
      .filter((account) => account && account.banned !== true && account.api_key && account.id != null)
      .map((account) => ({
        id: String(account.id),
        name: account.name?.trim() || `Account ${account.id}`,
        apiKey: String(account.api_key),
      }));

    if (accounts.length === 0) {
      throw new LoginError('This user has no active ScrapeOps account.');
    }
    return accounts;
  };
}
