# freshrss-mcp

> ## This is a fork
>
> Upstream is [ni-c/freshrss-mcp](https://github.com/ni-c/freshrss-mcp), and
> everything below this box is upstream's README. This fork's `main` is
> upstream's `main` plus one change and stays a superset of it: releases come in
> by merging the upstream tag, never by rebasing.
>
> **The divergence is a second serving entry.** `FRESHRSS_TRANSPORT=http` binds
> streamable HTTP on `0.0.0.0:8080`, with the MCP endpoint at `/mcp` and a
> liveness probe at `/health`. It exists because the
> [agentgateway](https://github.com/agentgateway/agentgateway) container in
> front of it is distroless and cannot spawn a stdio child, so anything behind
> it has to speak HTTP itself. Upstream
> [declined a native transport by design](https://github.com/ni-c/freshrss-mcp/issues/23):
> their servers are thin stdio processes and transport lives in their hub, so
> the patch lives here rather than in a pull request.
>
> Unset, or set to anything else, `FRESHRSS_TRANSPORT` leaves the server on
> stdio and every `npx` invocation documented below is unchanged. The one place
> the default differs is our container image, which sets it to `http` because
> that is the only reason the image is built.
>
> **Tags are `v<upstream>-bh.N`.** `v0.3.0-bh.1` is upstream 0.3.0 carrying the
> first revision of our patch, and it builds `ghcr.io/bobbyhyam/freshrss-mcp`.
> Nothing here is published to npm or to the MCP Registry: `@ni-c/freshrss-mcp`
> and the registry entry stay upstream's alone.

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/freshrss-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/freshrss-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Ffreshrss-mcp)](https://www.npmjs.com/package/@ni-c/freshrss-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Ffreshrss-mcp)](https://www.npmjs.com/package/@ni-c/freshrss-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Ffreshrss-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Ffreshrss-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Ffreshrss--mcp-blue)](https://github.com/ni-c/freshrss-mcp/pkgs/container/freshrss-mcp)
[![docs](https://img.shields.io/badge/docs-freshrss--mcp.ni--c.de-informational)](https://freshrss-mcp.ni-c.de)
[![HTTP • via mcp-hub](https://img.shields.io/badge/HTTP-via%20mcp--hub-6f42c1)](https://mcp-hub.ni-c.de)
[![Glama](https://glama.ai/mcp/servers/ni-c/freshrss-mcp/badges/score.svg)](https://glama.ai/mcp/servers/ni-c/freshrss-mcp)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[FreshRSS](https://freshrss.org), the self-hosted RSS and Atom feed aggregator.

Lets MCP clients like Claude Code, Claude Desktop or Codex work through your feeds:
see what is unread, read the articles, mark them, and manage subscriptions and
categories.

Sixteen tools is the ceiling, not the floor: `FRESHRSS_ALLOW_TOOLS=essential`
registers a curated seven instead, and a model picks the right tool far more
reliably from seven than from sixteen — see
[choosing which tools load](#choosing-which-tools-load).

It speaks the Google Reader compatible API that FreshRSS exposes at
`/api/greader.php`, and hides that API's quirks behind tool arguments an assistant can
actually use: numeric feed ids, category and label names, ISO dates and decimal
article ids instead of `user/-/state/com.google/…` stream identifiers and hexadecimal
item tags.

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://freshrss-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://freshrss-mcp.ni-c.de/architecture-light.svg">
  <img src="https://freshrss-mcp.ni-c.de/architecture.svg" alt="An MCP client speaks stdio to freshrss-mcp, which calls the Google Reader compatible API of FreshRSS over HTTPS with a GoogleLogin auth token" width="800">
</picture>

<!-- Recorded with vhs from docs/demo.tape against a throwaway FreshRSS 1.29.1. -->

![Demo: listing the tools, the subscribed feeds and the newest article through the MCP Inspector CLI](https://freshrss-mcp.ni-c.de/demo.gif)

## What makes it different

**Sixteen tools, no stream ids.** The Google Reader API speaks in stream
identifiers and hexadecimal item tags. These tools take numeric feed ids,
category and label names, ISO dates and decimal article ids, and hand back plain
text instead of raw HTML.

**Built for untrusted feeds.** Every article was written by a stranger on the
internet, so responses are marked as data, feed URLs are stripped of credentials,
and article text is capped per article and per response. The five irreversible
tools ask a person first, through MCP elicitation.

## Requirements

- Node.js 22 or newer
- A FreshRSS instance (developed against 1.29) with
  - the API enabled: **Settings → Authentication → "Allow API access"**
  - an **API password** set for the user: **Settings → Profile → API management**.
    This is a separate password from the web login.

## Configuration

| Variable                | Required | Description                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `FRESHRSS_URL`          | yes      | Root URL of the instance, e.g. `https://rss.example.com`. The API path `/api/greader.php` is appended automatically. |
| `FRESHRSS_USER`         | yes      | FreshRSS user name.                                                                                                  |
| `FRESHRSS_API_PASSWORD` | yes      | The **API password** from the profile page, not the web login password.                                              |
| `FRESHRSS_READ_ONLY`    | no       | `1`, `true` or `yes` registers only the read tools.                                                                  |
| `FRESHRSS_INSECURE_TLS` | no       | `true` accepts self-signed certificates for this connection only.                                                    |
| `FRESHRSS_ALLOW_TOOLS`  | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset                                   |
| `FRESHRSS_DENY_TOOLS`   | no       | Same syntax; removed from whatever `FRESHRSS_ALLOW_TOOLS` left                                                       |
| `ELICITATION`           | no       | `false` replaces the approval dialog with the two-call token. **Not prefixed.**                                      |

The server starts without credentials so its tools stay listable; every call
then fails with these setup instructions.

### Choosing which tools load

`FRESHRSS_ALLOW_TOOLS` and `FRESHRSS_DENY_TOOLS` take comma-separated tool names;
a trailing `*` matches a whole family. `essential` is a curated preset of
seven: `list_feeds`, `list_categories`, `get_unread_counts`, `list_articles`, `get_articles`, `mark_articles`, `mark_all_as_read`.

```sh
FRESHRSS_ALLOW_TOOLS=essential
FRESHRSS_ALLOW_TOOLS=list_feeds,list_articles,mark_articles
FRESHRSS_DENY_TOOLS=delete_*
```

An entry that matches no tool aborts startup and names it, so a typo cannot
silently hide a tool — an absent tool is not something anyone traces back to an
environment variable. A filtered tool is never registered, so it is absent from
`tools/list` and unknown to `tools/call` alike, exactly like a write tool under
`FRESHRSS_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de)
is the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.

## Installation

### Claude Code

```sh
claude mcp add freshrss -- npx -y @ni-c/freshrss-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "npx",
      "args": ["-y", "@ni-c/freshrss-mcp"],
      "env": {
        "FRESHRSS_URL": "https://rss.example.com",
        "FRESHRSS_USER": "alice",
        "FRESHRSS_API_PASSWORD": "…"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.freshrss]
command = "npx"
args = ["-y", "@ni-c/freshrss-mcp"]
env = { FRESHRSS_URL = "https://rss.example.com", FRESHRSS_USER = "alice", FRESHRSS_API_PASSWORD = "…" }
```

### Docker

```sh
docker run --rm -i \
  -e FRESHRSS_URL=https://rss.example.com \
  -e FRESHRSS_USER=alice \
  -e FRESHRSS_API_PASSWORD=... \
  ghcr.io/ni-c/freshrss-mcp:latest
```

The image is published for `linux/amd64` and `linux/arm64` with an SBOM and build
provenance. It runs as the unprivileged `node` user and carries no npm, so the
only thing in it is Node, the runtime dependencies and `dist/`.

### Through mcp-hub

A client that cannot spawn a local process — ChatGPT connectors, Claude on the web,
Cursor, LibreChat — reaches freshrss-mcp through [mcp-hub](https://mcp-hub.ni-c.de): one
container serves many stdio MCP servers over Streamable HTTP, with an OAuth 2.1 login
behind a single password and long-lived tokens for the clients that cannot do OAuth. Its
`/hub` endpoint puts every server behind six meta-tools, so one connector reaches all of
them without N×tool schemas in the model's context, and it speaks both protocol revisions
— a question this server asks travels through it to the person at the far end.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you already
have:

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "npx",
      "args": ["-y", "@ni-c/freshrss-mcp"],
      "env": { "FRESHRSS_ALLOW_TOOLS": "essential" },
      "denyTools": ["delete_*"]
    }
  }
}
```

`allowTools` and `denyTools` there are the hub's **own** per-server filter, which is not
the same thing as `*_ALLOW_TOOLS` in `env` — the difference, and the mistake it invites,
are in the [client guide](https://freshrss-mcp.ni-c.de/guide/clients#through-mcp-hub).

## Tools

### Reading

| Tool                | Description                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `get_user_info`     | The authenticated account — a quick credential check.                                       |
| `list_feeds`        | Every subscription with its category and unread count.                                      |
| `list_categories`   | Categories (folders of feeds) and user labels (tags on articles).                           |
| `get_unread_counts` | Total and per-feed/category unread counts, sorted.                                          |
| `list_articles`     | Articles of a feed, category, label or built-in stream, with excerpts or bounded full text. |
| `get_articles`      | Full text of specific articles by id.                                                       |
| `list_article_ids`  | Ids only — the cheap way to collect a set for `mark_articles`.                              |
| `export_opml`       | All subscriptions as an OPML document.                                                      |

### Writing

Not registered when `FRESHRSS_READ_ONLY=true`.

| Tool                       | Description                                           | Confirmation |
| -------------------------- | ----------------------------------------------------- | ------------ |
| `mark_articles`            | Set read state, star and labels on specific articles. | —            |
| `mark_all_as_read`         | Mark a whole feed, category, label or stream as read. | yes          |
| `subscribe_feed`           | Subscribe to a feed or website URL.                   | —            |
| `update_feed`              | Rename a feed or move it to another category.         | —            |
| `unsubscribe_feed`         | Delete a feed and all of its stored articles.         | yes          |
| `rename_category_or_label` | Rename a category or a user label.                    | —            |
| `delete_category_or_label` | Delete a category or a user label.                    | yes          |
| `import_opml`              | Subscribe to every feed in an OPML document.          | yes          |

### Structured output

Every tool declares an `outputSchema` and answers with `structuredContent`
alongside the text block, so a client can use the result without parsing prose:

```jsonc
{
  "untrusted": true,
  "source": "freshrss",
  "articles": [{ "id": "1234", "title": "…", "read": false, "starred": false }],
  "continuation": "1699999999",
  "notes": ["…"],
}
```

Every tool that reports feed content carries `untrusted: true` and
`source: "freshrss"` as fields. This server has always said so in `notes` —
prose in a list, which a client can read but not check — and the field is what
makes it checkable. Eight tools are without it, because their answer is entirely
this server's own words: ids it was given, a sentence built from the arguments,
the account it authenticates as.

Six tools used to answer with a sentence (_"Feed 9 deleted."_); they now answer
with the fields as well, and the sentence stays in the text block.
`export_opml` returns `{opml}` rather than the document as the whole result: a
schema whose root is a string is served to a 2025-era client rewritten as
`{result: …}`, and `truncated` needs somewhere to live either way.

### No search

FreshRSS does not offer full-text search over its API — the Google Reader
endpoints filter by stream, read state and date only. `list_articles` therefore
has no query parameter; narrow the result with `feed_id`/`category` and
`since`/`until` and filter the returned articles yourself.

## Not exposed, on purpose

**No full-text search**, because FreshRSS offers none over the Google Reader API:
its endpoints filter by stream, read state and date only. Narrow with `feed_id`,
`category`, `since` and `until`, then filter the returned articles yourself. The
search in the FreshRSS web interface has no API endpoint behind it.

**No raw HTML.** Article bodies are converted to plain text and capped per article
and per response, so one listing cannot bury everything else in the context.

## Safety

- **Article text is untrusted input.** Everything this server returns from
  FreshRSS was written by a third party on the internet, so responses that carry
  article text, titles or feed names are explicitly marked as data, never as
  instructions.
- **A person is asked, not just told.** Where the client supports MCP
  elicitation, the five irreversible tools raise a real dialog that the model
  cannot answer on its behalf. A plain boolean could be set on the very first
  call, or be talked into it by text hidden in a feed. Where the client cannot
  show a dialog they fall back to a single-use token bound to the exact target,
  and say so rather than implying somebody approved. The messages deliberately
  never quote titles or names coming from the API. See
  [Asking a person](https://freshrss-mcp.ni-c.de/guide/approval).
- **Response budgets.** FreshRSS returns up to 500 000 characters of HTML per
  article. Article text is converted to plain text, capped per article and
  against a per-response budget, and is opt-in in listings. The budget is
  charged for the markup that was read rather than for the text that came out,
  so it bounds the conversion work and not only the resulting context — markup
  that strips away to nothing is the expensive case, and it used to be free.
  The conversion itself is a single left-to-right scan, linear in the length of
  the article whatever the article contains.
- **Credentials** are read once, removed from `process.env` afterwards and never
  written to disk. Requests never follow redirects, which would resend the
  authorization header to another host, and relaxed TLS validation is scoped to
  this connection instead of the whole process.
- **Feed URLs are redacted.** FreshRSS stores HTTP-auth feeds as
  `https://user:password@host/feed`. The userinfo part is stripped before a feed
  URL reaches a tool result or the OPML export, so `list_feeds` cannot print the
  password of a paid or private feed into the transcript.
- **`subscribe_feed` and `import_opml` refuse internal targets.** FreshRSS
  fetches those URLs server-side, which makes both tools an SSRF primitive
  reachable from text inside an article. Loopback and link-local addresses —
  including cloud metadata endpoints — are rejected, for the feed URL and for
  every `xmlUrl`/`htmlUrl` in an OPML document. Addresses are compared
  numerically, so an IPv4-mapped IPv6 literal such as `[::ffff:169.254.169.254]`
  is caught too, and a hostname is resolved before it is accepted. An OPML
  document is read the way an XML parser reads it, and what reaches FreshRSS is
  the document as checked — so the URL that was inspected is the URL that gets
  fetched. Private LAN addresses stay allowed, because self-hosted setups
  legitimately subscribe to feeds on their own network.
- **`import_opml` refuses a `<!DOCTYPE>`.** No XML is parsed in this process, but
  the document is handed to FreshRSS, where a document type declaration is the
  carrier for entity-expansion and external-entity attacks. OPML never needs one.
- `FRESHRSS_READ_ONLY=true` does not register the write tools at all rather than
  refusing them at call time.

Which tools ask a person: `mark_all_as_read`, `unsubscribe_feed`,
`delete_category_or_label`, `import_opml` — and `mark_articles`, but only when it
is about to mark something **read**. Starring, unstarring and labelling can all
be set back; which of those articles were unread cannot, and FreshRSS keeps no
record of it.

## Documentation

The full guide, tool reference and security notes live at
**[freshrss-mcp.ni-c.de](https://freshrss-mcp.ni-c.de)** (source in [`docs/`](docs/)).

## Development

```sh
npm install
npm run lint && npm run build && npm test
npm run test:coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for a throwaway FreshRSS to develop
against. The full documentation lives at
[freshrss-mcp.ni-c.de](https://freshrss-mcp.ni-c.de).

## Releasing

1. Move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under the new
   version and bump `version` in `package.json`.
2. `npm run lint && npm run build && npm run test:coverage`.
3. Commit, then tag: `git tag -s vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.

The tag triggers `release.yml`, which verifies the tag matches `package.json`,
publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
with provenance (no token involved), creates the GitHub release from the CHANGELOG
section, and publishes the entry to the
[MCP Registry](https://registry.modelcontextprotocol.io). If only the registry
step fails, fix it on `main` and re-run `mcp-registry.yml` by hand — never re-run
the tagged job, which would check out the old tree.

## Contributing

Issues, discussions and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md). For vulnerabilities please use
[private reporting](https://github.com/ni-c/freshrss-mcp/security/advisories/new)
rather than a public issue; the policy is in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Willi Thiel
