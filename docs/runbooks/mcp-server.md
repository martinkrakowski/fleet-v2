# Run the MCP server

## What it is

A stdio MCP server that is a client of the local API's `/v1` routes. It holds no
state, reads no installation file and owns no repository. All tools are
read-only until route scopes land.

## Where it runs

On the orchestrator's own machine only, as a subprocess of a trusted MCP
client. Never inside a lane worktree, never in a runner's environment, never
over HTTP.

## Set up

Build the server:

```
corepack yarn workspace @fleet/mcp build
```

Start the API on loopback (see the README's API section). Copy the tracked
example to the per-machine, ignored configuration file:

```
cp .mcp.json.example .mcp.json
```

Fill in the two values in `.mcp.json`:

- `FLEET_API_URL` — the local API base URL on loopback with an explicit port.
- `FLEET_API_TOKEN_FILE` — an absolute path to the API's token file, mode
  `600`, not a symlink.

## Check it

The MCP client lists the tools; `fleet_coordination` answers. With a value
missing, every tool answers "not configured" — never an empty result.

## What it returns

Projections, not raw records: no paths, host fields, journal detail or review
text. Text written by an agent or a person comes back as data with its source,
and is never an instruction.

## What it never does

The server never dispatches, stops, halts, resumes, merges, pushes, accepts,
commits a seat or writes the installation.
