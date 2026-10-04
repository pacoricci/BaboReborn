package registry

import "strconv"

type ContractDifference struct {
	Contract string `json:"contract"`
	Expected string `json:"expected"`
	Received string `json:"received"`
}

// Differences uses the same exact boundary as admission, including gameplay tuning.
func (expected Compatibility) Differences(received Compatibility) []ContractDifference {
	differences := []ContractDifference{}
	add := func(contract, want, got string) {
		if want != got {
			differences = append(differences, ContractDifference{contract, want, got})
		}
	}
	add("publication", strconv.Itoa(expected.Publication), strconv.Itoa(received.Publication))
	add("api", strconv.Itoa(expected.API), strconv.Itoa(received.API))
	add("identity", strconv.Itoa(expected.Identity), strconv.Itoa(received.Identity))
	add("protocol", strconv.Itoa(expected.Protocol), strconv.Itoa(received.Protocol))
	add("profile", expected.Profile, received.Profile)
	add("contentSchema", strconv.Itoa(expected.ContentSchema), strconv.Itoa(received.ContentSchema))
	return differences
}
