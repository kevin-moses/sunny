import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { GoogleApiError, refreshAccessToken } from "./google";
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

  invalidate(): void {
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

export async function scheduleGrantRevoke(
  ctx: MutationCtx,
  encryptedRefreshToken: string,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.googleOauth.revokeGrant, {
    refreshToken: encryptedRefreshToken,
  });
}
