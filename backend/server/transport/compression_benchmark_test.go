package transport

import (
	"bytes"
	"compress/flate"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

// Replay real combat captures, not copies of one stationary JSON document.
// Simulation and JSON encoding are outside the timed transport measurement.
func compressionCorpus(b *testing.B, rooms int) [][][]byte {
	b.Helper()
	corpus := make([][][]byte, rooms)
	for room := range rooms {
		w := match.MustNew(testcontent.Map("yard"))
		w.Rules.ScoreLimit, w.Rules.TimeLimitTicks = 0, 0
		nav := navigation.New(w.Geometry.Grid)
		for i := range match.MaxPlayers {
			if _, err := w.AddBot(bots.NewSimple(bots.Standard(), uint32(9109+room*16+i)), nav); err != nil {
				b.Fatal(err)
			}
		}
		for tick := range 10 * gameconfig.TickHz {
			w.TimeMS = int64(tick * 1000 / gameconfig.TickHz)
			w.Step()
			if w.Tick%match.SnapshotEvery == 0 {
				body, err := wire.EncodeSnapshot(wire.Capture(w).ForRecipient(1))
				if err != nil {
					b.Fatal(err)
				}
				frame, err := encodeDelivery(replication.Envelope{Connection: fmt.Sprintf("benchmark-room-%d", room), Kind: replication.State, Sequence: len(corpus[room]) + 1, Generation: 1, EventThrough: w.EventCut(), SentAtMS: w.TimeMS, Body: body})
				if err != nil {
					b.Fatal(err)
				}
				corpus[room] = append(corpus[room], frame)
			}
			w.DrainEvents()
		}
	}
	return corpus
}

type countedReadConn struct {
	net.Conn
	bytes *atomic.Int64
}

func (c countedReadConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.bytes.Add(int64(n))
	return n, err
}

// Isolate codec CPU/allocations from socket scheduling and client decoding.
// coder/websocket uses BestSpeed and resets a pooled writer for each message.
func BenchmarkSnapshotDeflate(b *testing.B) {
	corpus := compressionCorpus(b, 1)[0]
	var out bytes.Buffer
	writer, err := flate.NewWriter(&out, flate.BestSpeed)
	if err != nil {
		b.Fatal(err)
	}
	defer writer.Close() //nolint:errcheck // In-memory benchmark cleanup.
	n, total := 0, 0
	b.ReportAllocs()
	for b.Loop() {
		out.Reset()
		writer.Reset(&out)
		if _, err := writer.Write(corpus[n%len(corpus)]); err != nil {
			b.Fatal(err)
		}
		if err := writer.Flush(); err != nil {
			b.Fatal(err)
		}
		total += out.Len() - 4 // permessage-deflate removes the sync-flush tail.
		n++
	}
	b.ReportMetric(float64(total)/float64(n), "deflate-B/op")
}

// One operation delivers one snapshot to every peer in every room. Counts are
// actual TCP-stream bytes including WebSocket framing, excluding the handshake,
// TCP/IP headers and TLS. Time/allocations include both Go socket endpoints and
// decompression; this is an unpaced loopback fan-out benchmark, not a playtest.
func BenchmarkSnapshotWebSocket(b *testing.B) {
	for _, rooms := range []int{1, 4} {
		corpus := compressionCorpus(b, rooms)
		for _, peers := range []int{1, 16} {
			for _, compressed := range []bool{false, true} {
				b.Run(fmt.Sprintf("rooms=%d/peers=%d/deflate=%t", rooms, peers, compressed), func(b *testing.B) {
					mode := websocket.CompressionDisabled
					if compressed {
						mode = websocket.CompressionNoContextTakeover
					}
					ctx := b.Context()
					accepted := make(chan *websocket.Conn, 1)
					srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: mode})
						if err != nil {
							b.Error(err)
							return
						}
						accepted <- c
					}))
					defer srv.Close()
					var wireBytes atomic.Int64
					transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
						c, err := (&net.Dialer{}).DialContext(ctx, network, address)
						if err != nil {
							return nil, err
						}
						return countedReadConn{c, &wireBytes}, nil
					}}
					defer transport.CloseIdleConnections()
					type endpoint struct {
						server   *websocket.Conn
						received chan []byte
					}
					endpoints := make([]endpoint, rooms*peers)
					for i := range endpoints {
						client, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), &websocket.DialOptions{HTTPClient: &http.Client{Transport: transport}, CompressionMode: mode})
						if err != nil {
							b.Fatal(err)
						}
						if strings.Contains(response.Header.Get("Sec-WebSocket-Extensions"), "permessage-deflate") != compressed {
							b.Fatal("unexpected compression negotiation")
						}
						defer client.CloseNow() //nolint:errcheck // Benchmark socket cleanup.
						client.SetReadLimit(2 << 20)
						e := endpoint{server: <-accepted, received: make(chan []byte, 1)}
						defer e.server.CloseNow() //nolint:errcheck // Benchmark socket cleanup.
						endpoints[i] = e
						go func() {
							defer close(e.received)
							for {
								_, data, err := client.Read(ctx)
								if err != nil {
									return
								}
								e.received <- data
							}
						}()
					}
					wireBytes.Store(0)
					var payloadBytes int64
					n := 0
					b.ReportAllocs()
					for b.Loop() {
						for i, e := range endpoints {
							frame := corpus[i/peers][n%len(corpus[i/peers])]
							if err := e.server.Write(ctx, websocket.MessageBinary, frame); err != nil {
								b.Fatal(err)
							}
							payloadBytes += int64(len(frame))
						}
						for i, e := range endpoints {
							if !bytes.Equal(<-e.received, corpus[i/peers][n%len(corpus[i/peers])]) {
								b.Fatal("decompressed snapshot differs from authority")
							}
						}
						n++
					}
					b.ReportMetric(float64(wireBytes.Load())/float64(n), "wire-B/op")
					b.ReportMetric(float64(payloadBytes)/float64(n), "payload-B/op")
					b.ReportMetric(float64(wireBytes.Load())*8*30/float64(n)/1e6, "wire-Mbit/s@30Hz")
				})
			}
		}
	}
}
