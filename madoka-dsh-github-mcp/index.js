// madoka-dsh-github-mcp — Host mount row for the token config page.
//
// This row exists so the bundle's browser half (client.js) has a Loader row
// to mount on: dsh-client-modules mounts a package's browser half on the row
// whose specifier equals the package name. It carries no Host logic; the
// GitHub MCP connection itself lives in the `madoka-github-mcp` row
// (@deepseek-ai/dsh-mcp-client bridge). The token form (plugins.row.config)
// writes into that row's `headers` and never echoes the secret back.
export const name = 'madoka-dsh-github-mcp'

export function apply() {}
