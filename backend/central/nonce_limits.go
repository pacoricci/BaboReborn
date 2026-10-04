package central

import "time"

const nonceLifetime = time.Minute
const maxLiveNoncesPerKey = 8
const maxLiveNoncesPerServer = 8
const maxLiveNoncesGlobal = 4096
const maxIssuedNoncesPerServer = 120
