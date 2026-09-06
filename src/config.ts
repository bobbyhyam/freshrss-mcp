import { internalHostKind } from 'mcp-internal-hosts';
import { redactUrlCredentials } from './redact.js';

export interface Config {
  /**
   * Base URL of the FreshRSS instance, e.g. `https://rss.example.com` — the
   * root of the web UI, *not* the API path. May be undefined together with the
   * credentials: the server still starts and lists its tools, every API call
   * then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  user: string | undefined;
  /**
   * The **API password** from the FreshRSS user profile, not the web login
   * password. FreshRSS stores it separately (`apiPasswordHash`) and the
   * Google Reader compatible API only ever checks that one.
   */
  apiPassword: string | undefined;
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;
  /**
   * Raw value of `FRESHRSS_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror of
   * the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `FRESHRSS_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: FRESHRSS_URL (e.g. https://rss.example.com), FRESHRSS_USER, FRESHRSS_API_PASSWORD\n' +
    'FRESHRSS_API_PASSWORD is the API password from the FreshRSS profile page ' +
    '(Settings → Profile → API management), not the web login password. The ' +
    'instance also needs the API enabled (Settings → Authentication → ' +
    '"Allow API access").\n' +
    'Optional: FRESHRSS_READ_ONLY=true to expose only read tools, ' +
    'FRESHRSS_INSECURE_TLS=true to accept self-signed certificates'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.url && 'FRESHRSS_URL',
    !config.user && 'FRESHRSS_USER',
    !config.apiPassword && 'FRESHRSS_API_PASSWORD',
  ].filter((v): v is string => Boolean(v));
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them. Here a typo
 * would leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  console.error(
    `freshrss-mcp: ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

/**
 * Which serving entry the process starts, from `FRESHRSS_TRANSPORT`.
 *
 * Fork addition, and the only one in this file. `http` binds the streamable
 * HTTP endpoint (see `src/http.ts`); anything else, unset included, is stdio,
 * so the npm behaviour and every `npx` invocation are untouched.
 *
 * Tolerant in the same direction as `FRESHRSS_READ_ONLY`: a value the operator
 * did not spell exactly leaves the default in place rather than refusing to
 * start. A container that meant to serve HTTP then fails its own healthcheck
 * within seconds, and the line below is what makes that a sentence rather than
 * a mystery.
 */
export function parseTransport(raw: string | undefined): 'stdio' | 'http' {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'stdio') return 'stdio';
  if (value === 'http') return 'http';
  console.error(
    `freshrss-mcp: FRESHRSS_TRANSPORT must be "stdio" or "http" — got "${raw}". Serving stdio.`
  );
  return 'stdio';
}

/**
 * Reads a switch that turns a protection *on*, and reads it tolerantly.
 *
 * `FRESHRSS_READ_ONLY=1` in a Docker Compose file, `=yes` from a shell script,
 * `=TRUE` from a Windows environment, a trailing space from a copied `.env`
 * line: an `=== 'true'` comparison answers all four with a server that quietly
 * exposes every write tool. The operator asked for the guard and does not find
 * out that they did not get it — which is exactly the failure a protection
 * switch must not have.
 *
 * The direction is what decides the strictness, not the variable. A switch that
 * *lifts* a protection is compared strictly, so that a typo leaves the
 * protection in place; see `FRESHRSS_INSECURE_TLS` above. `ELICITATION` is the
 * third case and refuses to start at all, because its default is on and a typo
 * there would be silent in both directions.
 */
function isEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(raw?.trim() ?? '');
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the credentials to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.FRESHRSS_URL;
  const user = env.FRESHRSS_USER;
  const apiPassword = env.FRESHRSS_API_PASSWORD;
  // Strict, and right to be: this one *removes* a protection, so anything the
  // operator did not spell exactly has to leave certificate checking on.
  const insecureTls = env.FRESHRSS_INSECURE_TLS === 'true';
  const readOnly = isEnabled(env.FRESHRSS_READ_ONLY);
  const allowTools = env.FRESHRSS_ALLOW_TOOLS;
  const denyTools = env.FRESHRSS_DENY_TOOLS;

  const missing = [
    !url && 'FRESHRSS_URL',
    !user && 'FRESHRSS_USER',
    !apiPassword && 'FRESHRSS_API_PASSWORD',
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) {
    console.error(`freshrss-mcp: ${missingConfigMessage(missing)}`);
  }

  // Don't keep the password in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ.
  delete env.FRESHRSS_API_PASSWORD;

  // After the delete, deliberately: this one can exit the process, and an exit
  // above would leave the credential in the environment for whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  if (!url) {
    return {
      url: undefined,
      user,
      apiPassword,
      insecureTls,
      readOnly,
      elicitation,
      allowTools,
      denyTools,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Redacted, and deliberately so: the userinfo check below only runs once the
    // URL parses, so a value that does not parse at all but still carries
    // credentials — "https://admin:s3cret@host:99999", an out-of-range port —
    // would otherwise print the API password into the MCP client's log file.
    console.error(
      `freshrss-mcp: FRESHRSS_URL is not a valid URL: ${redactUrlCredentials(url)}`
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `freshrss-mcp: FRESHRSS_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'freshrss-mcp: FRESHRSS_URL must not contain credentials — use FRESHRSS_USER and FRESHRSS_API_PASSWORD'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'freshrss-mcp: WARNING: FRESHRSS_URL uses plain http to a non-local host — ' +
        'the API password will be sent unencrypted. Use https:// instead.'
    );
  }

  return {
    url: url.replace(/\/+$/, ''),
    user,
    apiPassword,
    insecureTls,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };
}

function isLoopbackHost(hostname: string): boolean {
  // Same classifier the SSRF guard uses, so a loopback URL written as
  // http://[::1]:8013 or http://[::ffff:127.0.0.1]:8013 is recognised here too
  // and the plain-http warning does not fire on it.
  return internalHostKind(hostname) === 'loopback';
}
