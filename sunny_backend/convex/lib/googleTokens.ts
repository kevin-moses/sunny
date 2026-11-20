import { internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { GoogleApiError, refreshAccessToken, revokeRefreshToken } from "./google";
import { decryptSecret, encryptSecret } from "./secretBox";

const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export interface StoredGrant {
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
}

interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

export class AccessTokens {
  private current: AccessToken | null = null;

  constructor(
    private readonly grant: StoredGrant,
    private readonly save: (encrypted: string, expiresAt: number) => Promise<void>,
  ) {}

  async load(): Promise<AccessTokens> {
    const { accessToken, accessTokenExpiresAt } = this.grant;
    if (accessToken !== null && accessTokenExpiresAt !== null) {
      try {
        this.current = {
          accessToken: await decryptSecret(accessToken),
          expiresAt: accessTokenExpiresAt,
        };
      } catch {
        this.current = null;
      }
    }
    return this;
  }

  async get(): Promise<string> {
    if (this.current && this.current.expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return this.current.accessToken;
    }
    this.current = await refreshAccessToken(await decryptSecret(this.grant.refreshToken));
    await this.save(await encryptSecret(this.current.accessToken), this.current.expiresAt);
    return this.current.accessToken;
  }

  private invalidate(): void {
    this.current = null;
  }

  async withToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await call(await this.get());
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.status === 401)) throw e;
      this.invalidate();
      return await call(await this.get());
    }
  }
}

export function holdsGrant<Row extends { refreshToken: string }>(
  row: Row | null,
  refreshToken: string,
): row is Row {
  return row !== null && row.refreshToken === refreshToken;
}

export function googleAccount(email: string): string {
  return email.trim().toLowerCase();
}

export async function scheduleGrantRevoke(
  ctx: MutationCtx,
  encryptedRefreshToken: string,
  accountEmail: string | null,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.googleOauth.revokeGrant, {
    refreshToken: encryptedRefreshToken,
    accountEmail,
  });
}

export async function revokeUnusedGrant(
  ctx: ActionCtx,
  refreshToken: string,
  accountEmail: string | null,
): Promise<boolean> {
  if (accountEmail === null) return false;
  const inUse = await ctx.runQuery(internal.googleOauth.accountInUse, {
    accountEmail: googleAccount(accountEmail),
  });
  return inUse ? false : await revokeRefreshToken(refreshToken);
}
