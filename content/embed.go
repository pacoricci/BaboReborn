// Package content embeds the same installable packages used by community servers.
package content

import "embed"

//go:embed skins themes maps decals
var Files embed.FS
