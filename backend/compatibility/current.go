// Package compatibility describes the compiled release without importing server runtime code.
package compatibility

import (
	"baboreborn/backend/content"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/registry"
)

func Current() registry.Compatibility {
	return registry.Compatibility{Publication: registry.PublicationSchemaVersion, API: 1, Identity: 1, Protocol: gameconfig.ProtocolVersion, Profile: GameProfile(), ContentSchema: content.SchemaVersion}
}
