// A transport experiment, not the OpenMesh runtime. No third-party Go packages.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 3 { log.Fatal("usage: go-bench <scenario> <native|proxy> [upstream]") }
	scenario, mode := os.Args[1], os.Args[2]
	var handler http.Handler
	if mode == "proxy" {
		upstream, err := url.Parse(os.Args[3]); if err != nil { log.Fatal(err) }
		proxy := httputil.NewSingleHostReverseProxy(upstream)
		proxy.Transport = &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{Timeout: 2*time.Second, KeepAlive: 30*time.Second}).DialContext,
			MaxIdleConns: 256, MaxIdleConnsPerHost: 128, MaxConnsPerHost: 128,
			IdleConnTimeout: 60*time.Second, ResponseHeaderTimeout: 5*time.Second,
		}
		handler = proxy
	} else {
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if scenario == "middleware" { w.Header().Set("x-bench", "1") }
			if scenario == "plaintext" { w.Header().Set("content-type", "text/plain; charset=utf-8"); fmt.Fprint(w, "hello"); return }
			w.Header().Set("content-type", "application/json; charset=utf-8")
			var payload any = map[string]string{"hello": "world"}
			if scenario == "params" {
				if !strings.HasPrefix(r.URL.Path, "/users/") { http.NotFound(w, r); return }
				payload = map[string]string{"id": strings.TrimPrefix(r.URL.Path, "/users/")}
			}
			if scenario == "body" {
				r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil { http.Error(w, "Invalid JSON", 400); return }
			}
			data, err := json.Marshal(payload); if err != nil { http.Error(w, "Internal error", 500); return }
			w.Write(data)
		})
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0"); if err != nil { log.Fatal(err) }
	json.NewEncoder(os.Stdout).Encode(map[string]any{"port": listener.Addr().(*net.TCPAddr).Port, "go": runtime.Version(), "gomaxprocs": runtime.GOMAXPROCS(0)})
	server := &http.Server{ Handler: handler, ReadHeaderTimeout: 5*time.Second, IdleTimeout: 60*time.Second }
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed { log.Fatal(err) }
}
