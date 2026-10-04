package identity

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func Origin(value string, loopback bool) error {
	_, err := CanonicalOrigin(value, loopback)
	return err
}

// Browser origins fold DNS case and default ports; registry uniqueness uses that form.
func CanonicalOrigin(value string, loopback bool) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("absolute origin required")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", fmt.Errorf("absolute origin required")
	}
	for _, c := range host {
		if c > 127 || c == '%' {
			return "", fmt.Errorf("use an ASCII public hostname or IP address")
		}
	}
	ip := net.ParseIP(host)
	developmentHTTP := loopback && u.Scheme == "http" && (host == "localhost" || ip != nil && ip.IsLoopback())
	if u.Scheme != "https" && !developmentHTTP {
		return "", fmt.Errorf("HTTPS required; HTTP needs explicit loopback development mode")
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("invalid origin port")
		}
		port = strconv.Itoa(n)
		if u.Scheme == "https" && n == 443 || u.Scheme == "http" && n == 80 {
			port = ""
		}
	}
	if ip != nil {
		host = ip.String()
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return u.Scheme + "://" + host, nil
}
func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value) //nolint:errcheck // The response is already complete if the peer disconnects.
}
func Error(w http.ResponseWriter, status int, code string) {
	JSON(w, status, map[string]string{"error": code})
}
func Decode(w http.ResponseWriter, r *http.Request, out any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return fmt.Errorf("JSON required")
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	if err := d.Decode(out); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}
func SameOrigin(r *http.Request, origin string) bool {
	return r.Header.Get("Origin") == strings.TrimRight(origin, "/")
}
func Cookie(w http.ResponseWriter, name, value string, secure bool, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}
