/**
 * T3 account sign-in through Clerk's Frontend API in native (non-browser)
 * mode, the same mode T3's desktop and mobile apps use. The bridge keeps its
 * own Clerk client: signing in here does not touch any other device.
 *
 * Native mode: requests carry `Authorization: <client JWT>` and `_is_native=true`;
 * responses may return a rotated client JWT in the `authorization` header.
 */

export const DEFAULT_CLERK_FRONTEND_API = "https://clerk.t3.codes";
export const RELAY_JWT_TEMPLATE = "t3-relay";

export interface ClerkClientState {
  frontendApi: string;
  /** Long-lived native client JWT. Secret. */
  clientJwt: string;
  sessionId?: string;
}

interface ClerkEnvelope<T> {
  response?: T;
  client?: ClerkClient;
  errors?: { code: string; message: string; long_message?: string }[];
}

interface ClerkClient {
  id: string;
  sessions: { id: string; status: string }[];
  last_active_session_id: string | null;
}

interface ClerkSignIn {
  id: string;
  status: string;
  supported_first_factors?: { strategy: string; email_address_id?: string; safe_identifier?: string }[];
  created_session_id?: string | null;
}

export class ClerkError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ClerkError";
  }
}

export class ClerkAuth {
  constructor(
    private state: ClerkClientState,
    private readonly onStateChange: (state: ClerkClientState) => void | Promise<void> = () => {},
  ) {}

  static async createClient(frontendApi = DEFAULT_CLERK_FRONTEND_API): Promise<ClerkAuth> {
    const auth = new ClerkAuth({ frontendApi, clientJwt: "" });
    await auth.call<ClerkClient>("POST", "/v1/client");
    if (!auth.state.clientJwt) throw new ClerkError("T3 sign-in did not return a client token");
    return auth;
  }

  get current(): ClerkClientState {
    return { ...this.state };
  }

  get signedIn(): boolean {
    return Boolean(this.state.sessionId);
  }

  /** Starts email-code sign-in and returns the sign-in attempt id. */
  async startEmailCode(email: string): Promise<string> {
    const signIn = await this.call<ClerkSignIn>("POST", "/v1/client/sign_ins", { identifier: email });
    const factor = signIn.supported_first_factors?.find((f) => f.strategy === "email_code");
    if (!factor?.email_address_id) {
      throw new ClerkError(
        `This T3 account can't sign in with an email code (available: ${
          signIn.supported_first_factors?.map((f) => f.strategy).join(", ") || "none"
        })`,
      );
    }
    await this.call<ClerkSignIn>("POST", `/v1/client/sign_ins/${signIn.id}/prepare_first_factor`, {
      strategy: "email_code",
      email_address_id: factor.email_address_id,
    });
    return signIn.id;
  }

  async completeEmailCode(signInId: string, code: string): Promise<void> {
    const signIn = await this.call<ClerkSignIn>(
      "POST",
      `/v1/client/sign_ins/${signInId}/attempt_first_factor`,
      { strategy: "email_code", code: code.trim() },
    );
    if (signIn.status !== "complete" || !signIn.created_session_id) {
      throw new ClerkError(`Sign-in needs another step (${signIn.status}); not supported yet`);
    }
    this.state = { ...this.state, sessionId: signIn.created_session_id };
    await this.onStateChange(this.current);
  }

  /** Adopts the newest active session on the client, if any. */
  async refreshSession(): Promise<boolean> {
    const client = await this.call<ClerkClient>("GET", "/v1/client");
    const active = client.sessions.find((s) => s.status === "active" && s.id === client.last_active_session_id)
      ?? client.sessions.find((s) => s.status === "active");
    const sessionId = active?.id;
    if (sessionId !== this.state.sessionId) {
      this.state = { ...this.state, sessionId };
      await this.onStateChange(this.current);
    }
    return Boolean(sessionId);
  }

  /** Short-lived session JWT for the T3 relay (Clerk template "t3-relay"). */
  async relayToken(): Promise<string> {
    if (!this.state.sessionId) throw new ClerkError("Not signed in to T3. Run `t3-glasses setup`.");
    try {
      const result = await this.call<{ jwt: string }>(
        "POST",
        `/v1/client/sessions/${this.state.sessionId}/tokens/${RELAY_JWT_TEMPLATE}`,
      );
      if (!result?.jwt) throw new ClerkError("T3 sign-in returned no relay token");
      return result.jwt;
    } catch (error) {
      if (error instanceof ClerkError && (error.status === 401 || error.status === 404)) {
        this.state = { ...this.state, sessionId: undefined };
        await this.onStateChange(this.current);
        throw new ClerkError("Your T3 sign-in expired. Run `t3-glasses setup` again.", error.code, error.status);
      }
      throw error;
    }
  }

  async signOut(): Promise<void> {
    if (this.state.sessionId) {
      await this.call("POST", `/v1/client/sessions/${this.state.sessionId}/end`).catch(() => {});
    }
    this.state = { ...this.state, sessionId: undefined };
    await this.onStateChange(this.current);
  }

  private async call<T>(method: string, path: string, form?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.state.frontendApi);
    url.searchParams.set("_is_native", "true");
    const response = await fetch(url, {
      method,
      headers: {
        authorization: this.state.clientJwt,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const rotated = response.headers.get("authorization");
    if (rotated && rotated !== this.state.clientJwt) {
      this.state = { ...this.state, clientJwt: rotated };
      await this.onStateChange(this.current);
    }
    const body = (await response.json().catch(() => ({}))) as ClerkEnvelope<T> & T;
    if (!response.ok) {
      const first = body.errors?.[0];
      throw new ClerkError(
        first?.long_message || first?.message || `T3 sign-in request failed (HTTP ${response.status})`,
        first?.code,
        response.status,
      );
    }
    return (body.response ?? body) as T;
  }
}
