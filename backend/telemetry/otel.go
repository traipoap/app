// Package telemetry initializes the OpenTelemetry tracing stack and exposes
// helpers used by the Gin middleware (server spans) and the outbound HTTP
// clients (client spans). Spans are exported over OTLP/HTTP to the cluster's
// OTel Collector — or Tempo directly — for storage and querying in Grafana.
//
// Tracing is best-effort: if the collector is unreachable the API keeps
// serving, spans are dropped, and a single log line explains why.
package telemetry

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const tracerName = "lumina/backend"

// Tracer returns a tracer bound to the global provider. Call it lazily (at
// span-creation time, not package init) so it picks up the SDK provider
// installed by Init. Before Init the global noop provider is used.
func Tracer() trace.Tracer {
	return otel.Tracer(tracerName)
}

// w3c returns the W3C TraceContext + Baggage propagators (traceparent,
// tracestate, baggage headers) used for context propagation.
func w3c() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	)
}

// Init boots the TracerProvider and OTLP/HTTP exporter. It returns a
// shutdown callback that flushes pending spans (call it during process
// exit) and a bool reporting whether tracing is active.
//
// Configuration (standard OTel environment variables):
//
//	OTEL_SERVICE_NAME            default "lumina-backend"
//	OTEL_SERVICE_VERSION         default "dev"
//	OTEL_EXPORTER_OTLP_ENDPOINT  e.g. "http://tempo.observability.svc:4318"
//	                             default "http://127.0.0.1:4318"
//	OTEL_TRACES_SAMPLER_RATIO    0.0–1.0 head-based sampling, default 1.0
//	OTEL_TRACES_DISABLED         "true"/"1" forces the no-op provider
func Init(ctx context.Context) (func(context.Context) error, bool) {
	noop := func(context.Context) error { return nil }

	if v := os.Getenv("OTEL_TRACES_DISABLED"); v == "true" || v == "1" {
		otel.SetTextMapPropagator(w3c())
		log.Println("[telemetry] tracing disabled by OTEL_TRACES_DISABLED")
		return noop, false
	}

	raw := envOr("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
	// Accept both OTel-spec "host:port" (no scheme) and full URLs like
	// "http://host:port" — a scheme-less value must NOT be parsed as a URL
	// or the first dot-segment is mistaken for the scheme and host ends up
	// empty (which silently disabled tracing).
	scheme := "http"
	endpoint := raw
	if strings.HasPrefix(endpoint, "https://") {
		scheme = "https"
	} else if !strings.Contains(endpoint, "://") {
		endpoint = "http://" + endpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" {
		log.Printf("[telemetry] invalid OTEL_EXPORTER_OTLP_ENDPOINT %q — continuing without tracing", raw)
		return noop, false
	}
	// WithEndpoint (not WithEndpointURL) so the default "/v1/traces" path is
	// appended — WithEndpointURL silently POSTs to "/", which Tempo answers
	// with 404.
	opts := []otlptracehttp.Option{otlptracehttp.WithEndpoint(u.Host)}
	if scheme == "https" {
		// default TLS credentials
	} else {
		opts = append(opts, otlptracehttp.WithInsecure())
	}
	exporter, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		log.Printf("[telemetry] OTLP exporter init failed (%v) — continuing without tracing", err)
		return noop, false
	}

	res, err := resource.New(ctx, resource.WithAttributes(
		attribute.String("service.name", envOr("OTEL_SERVICE_NAME", "lumina-backend")),
		attribute.String("service.version", envOr("OTEL_SERVICE_VERSION", "dev")),
	))
	if err != nil {
		log.Printf("[telemetry] resource build failed (%v) — falling back to defaults", err)
		res = resource.Default()
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(samplerRatio()))),
		sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(5*time.Second)),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(w3c())
	log.Printf("[telemetry] tracing enabled → %s (service=%s)",
		raw, envOr("OTEL_SERVICE_NAME", "lumina-backend"))
	return tp.Shutdown, true
}

// OTelTransport wraps an http.RoundTripper and records a client span for
// every outbound request, linked to whatever server span is active in the
// request context. This is what makes "backend → Quickwit" show up as a
// child span in Tempo instead of a black box.
type OTelTransport struct {
	Base http.RoundTripper
}

func (t *OTelTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}

	spanName := req.Method + " " + req.URL.Host
	ctx, span := Tracer().Start(req.Context(), spanName, trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("http.request.method", req.Method),
			attribute.String("url.full", req.URL.Host+req.URL.Path),
		),
	)
	req = req.WithContext(ctx)

	resp, err := base.RoundTrip(req)
	switch {
	case err != nil:
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	case resp.StatusCode >= 500:
		span.SetStatus(codes.Error, "HTTP 5xx")
	}
	if resp != nil {
		span.SetAttributes(attribute.Int("http.response.status_code", resp.StatusCode))
	}
	span.End()
	return resp, err
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func samplerRatio() float64 {
	if v := os.Getenv("OTEL_TRACES_SAMPLER_RATIO"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 && f <= 1 {
			return f
		}
	}
	return 1.0
}
